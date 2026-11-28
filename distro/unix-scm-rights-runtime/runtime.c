#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int send_one_fd(int sock, int fd_to_send, char tag) {
  char cbuf[CMSG_SPACE(sizeof(int))];
  struct iovec iov;
  struct msghdr msg;
  struct cmsghdr *cmsg;

  memset(&msg, 0, sizeof(msg));
  memset(cbuf, 0, sizeof(cbuf));
  iov.iov_base = &tag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof(cbuf);

  cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg)
    return 1;
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &fd_to_send, sizeof(int));
  msg.msg_controllen = cmsg->cmsg_len;

  if (sendmsg(sock, &msg, 0) != 1)
    return fail_errno("sendmsg(SCM_RIGHTS)");
  return 0;
}

static int recv_one_fd(int sock, int *out_fd, char expected_tag) {
  char rtag = 0;
  char cbuf[CMSG_SPACE(sizeof(int))];
  struct iovec iov;
  struct msghdr msg;
  struct cmsghdr *cmsg;

  memset(&msg, 0, sizeof(msg));
  memset(cbuf, 0, sizeof(cbuf));
  iov.iov_base = &rtag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof(cbuf);

  if (recvmsg(sock, &msg, 0) != 1 || rtag != expected_tag)
    return fail_errno("recvmsg(SCM_RIGHTS)");

  cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg || cmsg->cmsg_level != SOL_SOCKET ||
      cmsg->cmsg_type != SCM_RIGHTS ||
      cmsg->cmsg_len < CMSG_LEN(sizeof(int))) {
    fprintf(stderr, "FAIL: missing SCM_RIGHTS cmsg\n");
    return 1;
  }
  memcpy(out_fd, CMSG_DATA(cmsg), sizeof(int));
  return 0;
}

static int test_stream_peercred_and_pipe_fd(void) {
  int sv[2], pfd[2], recv_fd = -1;
  struct ucred peer;
  socklen_t len = sizeof(peer);
  struct stat st_orig, st_recv;
  char part1[6], part2[16];

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
    return fail_errno("socketpair(SOCK_STREAM)");

  memset(&peer, 0, sizeof(peer));
  if (getsockopt(sv[0], SOL_SOCKET, SO_PEERCRED, &peer, &len) != 0)
    return fail_errno("getsockopt(SO_PEERCRED)");
  if (peer.pid != getpid() || peer.uid != geteuid() || peer.gid != getegid()) {
    fprintf(stderr, "FAIL: SO_PEERCRED pid=%ld uid=%u gid=%u\n",
            (long)peer.pid, (unsigned)peer.uid, (unsigned)peer.gid);
    return 1;
  }

  if (pipe2(pfd, O_CLOEXEC) != 0)
    return fail_errno("pipe2");
  if (write(pfd[1], "pipe-hello-world", 16) != 16)
    return fail_errno("write(pipe)");
  if (close(pfd[1]) != 0)
    return fail_errno("close(pfd[1])");

  if (fstat(pfd[0], &st_orig) != 0)
    return fail_errno("fstat(pipe)");
  if (send_one_fd(sv[0], pfd[0], 'P') != 0)
    return 1;
  if (close(pfd[0]) != 0)
    return fail_errno("close(orig pfd[0])");

  if (recv_one_fd(sv[1], &recv_fd, 'P') != 0)
    return 1;
  if (fstat(recv_fd, &st_recv) != 0 ||
      st_recv.st_ino != st_orig.st_ino || st_recv.st_dev != st_orig.st_dev) {
    fprintf(stderr, "FAIL: pipe fd inode mismatch\n");
    return 1;
  }

  memset(part1, 0, sizeof(part1));
  memset(part2, 0, sizeof(part2));
  if (read(recv_fd, part1, 5) != 5 || strcmp(part1, "pipe-") != 0) {
    fprintf(stderr, "FAIL: partial read 1 got '%s'\n", part1);
    return 1;
  }
  if (read(recv_fd, part2, 11) != 11 || strcmp(part2, "hello-world") != 0) {
    fprintf(stderr, "FAIL: partial read 2 got '%s'\n", part2);
    return 1;
  }

  if (close(recv_fd) != 0 || close(sv[0]) != 0 || close(sv[1]) != 0)
    return fail_errno("close(stream)");

  printf("stream_peercred_pipe: ok\n");
  return 0;
}

static int test_dgram_memfd_and_credentials(void) {
  int dv[2], mfd, recv_fd = -1, one = 1;
  struct stat st_orig, st_recv;
  char mbuf[16], cbuf[CMSG_SPACE(sizeof(struct ucred))];
  char tag = 'C', rtag = 0;
  struct ucred tx_cred, rx_cred;
  struct iovec iov;
  struct msghdr msg;
  struct cmsghdr *cmsg;

  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, dv) != 0)
    return fail_errno("socketpair(SOCK_DGRAM)");

  mfd = memfd_create("scm-memfd", MFD_CLOEXEC);
  if (mfd < 0)
    return fail_errno("memfd_create");
  if (write(mfd, "memfd-data", 10) != 10 || lseek(mfd, 0, SEEK_SET) != 0)
    return fail_errno("write/lseek(memfd)");
  if (fstat(mfd, &st_orig) != 0)
    return fail_errno("fstat(memfd)");

  if (send_one_fd(dv[0], mfd, 'M') != 0)
    return 1;
  if (close(mfd) != 0)
    return fail_errno("close(orig memfd)");

  if (recv_one_fd(dv[1], &recv_fd, 'M') != 0)
    return 1;
  if (fstat(recv_fd, &st_recv) != 0 ||
      st_recv.st_ino != st_orig.st_ino || st_recv.st_dev != st_orig.st_dev) {
    fprintf(stderr, "FAIL: memfd inode mismatch\n");
    return 1;
  }
  memset(mbuf, 0, sizeof(mbuf));
  if (read(recv_fd, mbuf, 10) != 10 || strcmp(mbuf, "memfd-data") != 0) {
    fprintf(stderr, "FAIL: memfd read got '%s'\n", mbuf);
    return 1;
  }
  if (close(recv_fd) != 0)
    return fail_errno("close(recv memfd)");

  if (setsockopt(dv[1], SOL_SOCKET, SO_PASSCRED, &one, sizeof(one)) != 0)
    return fail_errno("setsockopt(SO_PASSCRED)");

  memset(&msg, 0, sizeof(msg));
  memset(cbuf, 0, sizeof(cbuf));
  iov.iov_base = &tag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof(cbuf);

  tx_cred.pid = getpid();
  tx_cred.uid = geteuid();
  tx_cred.gid = getegid();
  cmsg = CMSG_FIRSTHDR(&msg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_CREDENTIALS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(struct ucred));
  memcpy(CMSG_DATA(cmsg), &tx_cred, sizeof(struct ucred));
  msg.msg_controllen = cmsg->cmsg_len;

  if (sendmsg(dv[0], &msg, 0) != 1)
    return fail_errno("sendmsg(SCM_CREDENTIALS)");

  memset(&msg, 0, sizeof(msg));
  memset(cbuf, 0, sizeof(cbuf));
  iov.iov_base = &rtag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cbuf;
  msg.msg_controllen = sizeof(cbuf);

  if (recvmsg(dv[1], &msg, 0) != 1 || rtag != 'C')
    return fail_errno("recvmsg(SCM_CREDENTIALS)");

  cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg || cmsg->cmsg_level != SOL_SOCKET ||
      cmsg->cmsg_type != SCM_CREDENTIALS ||
      cmsg->cmsg_len < CMSG_LEN(sizeof(struct ucred))) {
    fprintf(stderr, "FAIL: missing SCM_CREDENTIALS cmsg\n");
    return 1;
  }
  memcpy(&rx_cred, CMSG_DATA(cmsg), sizeof(struct ucred));
  if (rx_cred.pid != tx_cred.pid || rx_cred.uid != tx_cred.uid ||
      rx_cred.gid != tx_cred.gid) {
    fprintf(stderr, "FAIL: SCM_CREDENTIALS mismatch\n");
    return 1;
  }

  if (close(dv[0]) != 0 || close(dv[1]) != 0)
    return fail_errno("close(dgram)");

  printf("dgram_memfd_cred: ok\n");
  return 0;
}

int main(void) {
  if (test_stream_peercred_and_pipe_fd() != 0)
    return 1;
  if (test_dgram_memfd_and_credentials() != 0)
    return 1;
  printf("unix-scm-rights-runtime: PASS\n");
  return 0;
}
