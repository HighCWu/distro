#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/uio.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "pipe2-splice-tee-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

int main(void) {
  int p1[2];
  int p2[2];
  require(pipe2(p1, O_NONBLOCK | O_CLOEXEC) == 0, "pipe2 p1");
  require(pipe2(p2, O_NONBLOCK | O_CLOEXEC) == 0, "pipe2 p2");

  int sz = fcntl(p1[0], F_GETPIPE_SZ);
  require(sz >= 4096, "F_GETPIPE_SZ");
  int set_sz = fcntl(p1[0], F_SETPIPE_SZ, 8192);
  require(set_sz >= 8192, "F_SETPIPE_SZ");

  char part1[] = "wasm-pipe-";
  char part2[] = "splice-tee-v1";
  struct iovec iov[2] = {
      {.iov_base = part1, .iov_len = sizeof(part1) - 1},
      {.iov_base = part2, .iov_len = sizeof(part2) - 1},
  };
  size_t total = (sizeof(part1) - 1) + (sizeof(part2) - 1);

  ssize_t vn = vmsplice(p1[1], iov, 2, 0);
  require(vn == (ssize_t)total, "vmsplice into p1");

  int avail = 0;
  require(ioctl(p1[0], FIONREAD, &avail) == 0 && avail == (int)total,
          "FIONREAD == total");

  ssize_t tn = tee(p1[0], p2[1], total, 0);
  require(tn == (ssize_t)total, "tee p1 -> p2");

  int out_fd =
      open("/tmp/splice_out.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(out_fd >= 0, "open(/tmp/splice_out.bin)");

  off_t off = 0;
  ssize_t sn = splice(p1[0], NULL, out_fd, &off, total, 0);
  require(sn == (ssize_t)total && off == (off_t)total, "splice p1 -> out_fd");

  char fbuf[64];
  require(pread(out_fd, fbuf, total, 0) == (ssize_t)total, "pread out_fd");
  require(memcmp(fbuf, "wasm-pipe-splice-tee-v1", total) == 0,
          "splice file payload");

  char pbuf[64];
  require(read(p2[0], pbuf, sizeof(pbuf)) == (ssize_t)total, "read teed p2");
  require(memcmp(pbuf, "wasm-pipe-splice-tee-v1", total) == 0,
          "tee payload match");

  require(signal(SIGPIPE, SIG_IGN) != SIG_ERR, "ignore SIGPIPE");
  require(close(p1[0]) == 0, "close p1[0]");
  require(write(p1[1], "x", 1) == -1 && errno == EPIPE,
          "write to broken pipe EPIPE");

  require(close(out_fd) == 0, "close out_fd");
  require(unlink("/tmp/splice_out.bin") == 0, "unlink splice_out.bin");
  require(close(p1[1]) == 0, "close p1[1]");
  require(close(p2[0]) == 0, "close p2[0]");
  require(close(p2[1]) == 0, "close p2[1]");

  printf("pipe2-splice-tee-runtime: ok sz=%d bytes=%zu\n", set_sz, total);
  return 0;
}
