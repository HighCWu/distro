#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int test_stream_shutdown(void) {
  int sv[2];
  char buf[32];
  ssize_t n;

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
    return fail_errno("socketpair(SOCK_STREAM)");

  if (write(sv[0], "hello", 5) != 5)
    return fail_errno("write(sv[0])");

  memset(buf, 0, sizeof(buf));
  n = read(sv[1], buf, sizeof(buf));
  if (n != 5 || memcmp(buf, "hello", 5) != 0) {
    fprintf(stderr, "FAIL: stream read got %zd bytes\n", n);
    return 1;
  }

  if (shutdown(sv[0], SHUT_WR) != 0)
    return fail_errno("shutdown(sv[0], SHUT_WR)");

  n = read(sv[1], buf, sizeof(buf));
  if (n != 0) {
    fprintf(stderr, "FAIL: expected EOF (0) after SHUT_WR, got %zd\n", n);
    return 1;
  }

  if (write(sv[1], "reply", 5) != 5)
    return fail_errno("write(sv[1] after sv[0] SHUT_WR)");

  memset(buf, 0, sizeof(buf));
  n = read(sv[0], buf, sizeof(buf));
  if (n != 5 || memcmp(buf, "reply", 5) != 0) {
    fprintf(stderr, "FAIL: reverse read got %zd bytes\n", n);
    return 1;
  }

  if (close(sv[0]) != 0 || close(sv[1]) != 0)
    return fail_errno("close(sv)");

  printf("stream_shutdown: ok\n");
  return 0;
}

static int test_dgram_boundaries(void) {
  int dv[2];
  int sndbuf = 0, rcvbuf = 0;
  socklen_t optlen;
  char buf[32];
  ssize_t n;

  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, dv) != 0)
    return fail_errno("socketpair(SOCK_DGRAM)");

  optlen = sizeof(sndbuf);
  if (getsockopt(dv[0], SOL_SOCKET, SO_SNDBUF, &sndbuf, &optlen) != 0 ||
      sndbuf <= 0)
    return fail_errno("getsockopt(SO_SNDBUF)");

  optlen = sizeof(rcvbuf);
  if (getsockopt(dv[1], SOL_SOCKET, SO_RCVBUF, &rcvbuf, &optlen) != 0 ||
      rcvbuf <= 0)
    return fail_errno("getsockopt(SO_RCVBUF)");

  if (write(dv[0], "first", 5) != 5 || write(dv[0], "second", 6) != 6)
    return fail_errno("write(dgram)");

  memset(buf, 0, sizeof(buf));
  n = read(dv[1], buf, sizeof(buf));
  if (n != 5 || memcmp(buf, "first", 5) != 0) {
    fprintf(stderr, "FAIL: dgram 1st read got %zd\n", n);
    return 1;
  }

  memset(buf, 0, sizeof(buf));
  n = read(dv[1], buf, sizeof(buf));
  if (n != 6 || memcmp(buf, "second", 6) != 0) {
    fprintf(stderr, "FAIL: dgram 2nd read got %zd\n", n);
    return 1;
  }

  if (close(dv[0]) != 0 || close(dv[1]) != 0)
    return fail_errno("close(dv)");

  printf("dgram_boundaries: ok (sndbuf=%d rcvbuf=%d)\n", sndbuf, rcvbuf);
  return 0;
}

static int test_scm_rights(void) {
  int sv[2], pfd[2];
  int recv_fd = -1;
  struct stat st_orig, st_recv;
  const char tag = 'R';
  const char pipe_msg[] = "ancillary-pipe-data";
  char rtag = 0, pbuf[64];
  char cmsg_tx[CMSG_SPACE(sizeof(int))];
  char cmsg_rx[CMSG_SPACE(sizeof(int))];
  struct iovec iov;
  struct msghdr msg;
  struct cmsghdr *cmsg;
  ssize_t n;

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
    return fail_errno("socketpair(SCM_RIGHTS)");
  if (pipe2(pfd, O_NONBLOCK | O_CLOEXEC) != 0)
    return fail_errno("pipe2");

  if (write(pfd[1], pipe_msg, sizeof(pipe_msg) - 1) !=
      (ssize_t)(sizeof(pipe_msg) - 1))
    return fail_errno("write(pipe)");
  if (close(pfd[1]) != 0)
    return fail_errno("close(pfd[1])");

  if (fstat(pfd[0], &st_orig) != 0)
    return fail_errno("fstat(orig)");

  memset(&msg, 0, sizeof(msg));
  memset(cmsg_tx, 0, sizeof(cmsg_tx));
  iov.iov_base = (void *)&tag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cmsg_tx;
  msg.msg_controllen = sizeof(cmsg_tx);

  cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg) {
    fprintf(stderr, "FAIL: CMSG_FIRSTHDR(tx) returned NULL\n");
    return 1;
  }
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &pfd[0], sizeof(int));
  msg.msg_controllen = cmsg->cmsg_len;

  if (sendmsg(sv[0], &msg, 0) != 1)
    return fail_errno("sendmsg(SCM_RIGHTS)");

  if (close(pfd[0]) != 0)
    return fail_errno("close(orig pfd[0])");

  memset(&msg, 0, sizeof(msg));
  memset(cmsg_rx, 0, sizeof(cmsg_rx));
  iov.iov_base = &rtag;
  iov.iov_len = 1;
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  msg.msg_control = cmsg_rx;
  msg.msg_controllen = sizeof(cmsg_rx);

  n = recvmsg(sv[1], &msg, 0);
  if (n != 1 || rtag != tag) {
    fprintf(stderr, "FAIL: recvmsg n=%zd rtag=0x%x\n", n, (unsigned)rtag);
    return 1;
  }

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wsign-compare"
#endif
  for (cmsg = CMSG_FIRSTHDR(&msg); cmsg != NULL;
       cmsg = CMSG_NXTHDR(&msg, cmsg)) {
#if defined(__clang__)
#pragma clang diagnostic pop
#endif
    if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS &&
        cmsg->cmsg_len >= CMSG_LEN(sizeof(int))) {
      memcpy(&recv_fd, CMSG_DATA(cmsg), sizeof(int));
      break;
    }
  }

  if (recv_fd < 0) {
    fprintf(stderr, "FAIL: SCM_RIGHTS did not deliver fd\n");
    return 1;
  }

  if (fstat(recv_fd, &st_recv) != 0)
    return fail_errno("fstat(recv_fd)");
  if (st_recv.st_ino != st_orig.st_ino || st_recv.st_dev != st_orig.st_dev) {
    fprintf(stderr, "FAIL: inode/dev mismatch orig=%llu recv=%llu\n",
            (unsigned long long)st_orig.st_ino,
            (unsigned long long)st_recv.st_ino);
    return 1;
  }

  memset(pbuf, 0, sizeof(pbuf));
  n = read(recv_fd, pbuf, sizeof(pbuf));
  if (n != (ssize_t)(sizeof(pipe_msg) - 1) ||
      memcmp(pbuf, pipe_msg, sizeof(pipe_msg) - 1) != 0) {
    fprintf(stderr, "FAIL: read(recv_fd) got %zd bytes\n", n);
    return 1;
  }

  if (close(recv_fd) != 0 || close(sv[0]) != 0 || close(sv[1]) != 0)
    return fail_errno("close(scm_rights)");

  printf("scm_rights: ok (ino=%llu)\n", (unsigned long long)st_recv.st_ino);
  return 0;
}

int main(void) {
  if (test_stream_shutdown() != 0)
    return 1;
  if (test_dgram_boundaries() != 0)
    return 1;
  if (test_scm_rights() != 0)
    return 1;
  printf("socketpair-shutdown-ancillary-runtime: PASS\n");
  return 0;
}
