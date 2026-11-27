#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "socket-unix-seqpacket-runtime: %s (errno=%d: %s)\n", what,
          errno, strerror(errno));
  exit(1);
}

static void recv_exact_record(int fd, const char *expected, size_t len) {
  char buf[64];
  struct iovec iov = {.iov_base = buf, .iov_len = sizeof(buf)};
  struct msghdr msg;
  memset(&msg, 0, sizeof(msg));
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;

  ssize_t n = recvmsg(fd, &msg, 0);
  require(n == (ssize_t)len, "recvmsg record len");
  require((msg.msg_flags & MSG_EOR) != 0, "MSG_EOR set");
  require((msg.msg_flags & MSG_TRUNC) == 0, "MSG_TRUNC clear");
  require(memcmp(buf, expected, len) == 0, "record payload");
}

int main(void) {
  int sp[2];
  require(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sp) == 0,
          "socketpair(SOCK_SEQPACKET)");

  require(send(sp[0], "rec-one", 7, 0) == 7, "send rec-one");
  require(send(sp[0], "rec-two-longer", 14, 0) == 14, "send rec-two");

  recv_exact_record(sp[1], "rec-one", 7);

  char tiny[4];
  struct iovec piov = {.iov_base = tiny, .iov_len = sizeof(tiny)};
  struct msghdr pmsg;
  memset(&pmsg, 0, sizeof(pmsg));
  pmsg.msg_iov = &piov;
  pmsg.msg_iovlen = 1;
  ssize_t pn = recvmsg(sp[1], &pmsg, MSG_PEEK | MSG_TRUNC);
  require(pn == 14 && (pmsg.msg_flags & MSG_TRUNC) != 0,
          "MSG_PEEK | MSG_TRUNC full len");

  memset(&pmsg, 0, sizeof(pmsg));
  pmsg.msg_iov = &piov;
  pmsg.msg_iovlen = 1;
  pn = recvmsg(sp[1], &pmsg, MSG_TRUNC);
  require(pn == 14 && (pmsg.msg_flags & MSG_TRUNC) != 0,
          "MSG_TRUNC discards remainder");
  require(memcmp(tiny, "rec-", 4) == 0, "truncated prefix");

  char ebuf[8];
  require(recv(sp[1], ebuf, sizeof(ebuf), MSG_DONTWAIT) == -1 &&
              (errno == EAGAIN || errno == EWOULDBLOCK),
          "no leftover bytes after truncated record");

  require(close(sp[0]) == 0, "close sp[0]");
  require(close(sp[1]) == 0, "close sp[1]");

  int srv = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  require(srv >= 0, "socket(AF_UNIX, SOCK_SEQPACKET)");

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  const char abst[] = "\0wasm-seqpacket-test";
  size_t abst_len = sizeof(abst) - 1;
  memcpy(addr.sun_path, abst, abst_len);
  socklen_t alen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + abst_len);

  require(bind(srv, (const struct sockaddr *)&addr, alen) == 0, "bind abstract");
  require(listen(srv, 4) == 0, "listen");

  int cli = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  require(cli >= 0, "socket cli");
  require(connect(cli, (const struct sockaddr *)&addr, alen) == 0, "connect");

  int acc = accept4(srv, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
  require(acc >= 0, "accept4");

  struct ucred cred;
  socklen_t clen = sizeof(cred);
  require(getsockopt(acc, SOL_SOCKET, SO_PEERCRED, &cred, &clen) == 0,
          "SO_PEERCRED");
  require(cred.pid == getpid() && cred.uid == getuid() && cred.gid == getgid(),
          "SO_PEERCRED match");

  int pfd[2];
  require(pipe2(pfd, O_CLOEXEC) == 0, "pipe2");

  char cbuf[CMSG_SPACE(sizeof(int))];
  memset(cbuf, 0, sizeof(cbuf));
  char tag[] = "fd-pass";
  struct iovec siov = {.iov_base = tag, .iov_len = sizeof(tag) - 1};
  struct msghdr smsg;
  memset(&smsg, 0, sizeof(smsg));
  smsg.msg_iov = &siov;
  smsg.msg_iovlen = 1;
  smsg.msg_control = cbuf;
  smsg.msg_controllen = sizeof(cbuf);

  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&smsg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &pfd[1], sizeof(int));

  require(sendmsg(cli, &smsg, 0) == (ssize_t)(sizeof(tag) - 1),
          "sendmsg SCM_RIGHTS");
  require(close(pfd[1]) == 0, "close original pfd[1]");

  char rtag[16];
  char rcbuf[CMSG_SPACE(sizeof(int))];
  struct iovec riov = {.iov_base = rtag, .iov_len = sizeof(rtag)};
  struct msghdr rmsg;
  memset(&rmsg, 0, sizeof(rmsg));
  rmsg.msg_iov = &riov;
  rmsg.msg_iovlen = 1;
  rmsg.msg_control = rcbuf;
  rmsg.msg_controllen = sizeof(rcbuf);

  ssize_t rn = recvmsg(acc, &rmsg, 0);
  require(rn == (ssize_t)(sizeof(tag) - 1), "recvmsg SCM_RIGHTS");
  require(memcmp(rtag, tag, sizeof(tag) - 1) == 0, "SCM_RIGHTS payload");

  int got_fd = -1;
  for (struct cmsghdr *rc = CMSG_FIRSTHDR(&rmsg); rc != NULL;
       rc = CMSG_NXTHDR(&rmsg, rc)) {
    if (rc->cmsg_level == SOL_SOCKET && rc->cmsg_type == SCM_RIGHTS) {
      memcpy(&got_fd, CMSG_DATA(rc), sizeof(int));
      break;
    }
  }
  require(got_fd >= 0, "extracted SCM_RIGHTS fd");

  const char pmsg_txt[] = "pipe-via-seqpacket";
  require(write(got_fd, pmsg_txt, sizeof(pmsg_txt) - 1) ==
              (ssize_t)(sizeof(pmsg_txt) - 1),
          "write received fd");
  char pbuf[32];
  require(read(pfd[0], pbuf, sizeof(pbuf)) == (ssize_t)(sizeof(pmsg_txt) - 1),
          "read pipe");
  require(memcmp(pbuf, pmsg_txt, sizeof(pmsg_txt) - 1) == 0, "pipe payload");

  require(shutdown(cli, SHUT_WR) == 0, "shutdown(SHUT_WR)");
  require(recv(acc, rtag, sizeof(rtag), 0) == 0, "EOF after shutdown");

  require(close(got_fd) == 0, "close got_fd");
  require(close(pfd[0]) == 0, "close pfd[0]");
  require(close(acc) == 0, "close acc");
  require(close(cli) == 0, "close cli");
  require(close(srv) == 0, "close srv");

  printf("socket-unix-seqpacket-runtime: ok pid=%d\n", (int)cred.pid);
  return 0;
}
