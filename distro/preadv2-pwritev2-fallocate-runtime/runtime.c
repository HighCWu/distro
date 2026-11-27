#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "preadv2-pwritev2-fallocate-runtime: %s (errno=%d: %s)\n",
          what, errno, strerror(errno));
  exit(1);
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext4", 0, NULL) == 0,
          "mount(/dev/vda, ext4)");

  int rw_fd =
      open("/mnt/iov2.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(rw_fd >= 0, "open(/mnt/iov2.bin)");

  char w1[] = "alpha-";
  char w2[] = "beta-";
  char w3[] = "gamma";
  struct iovec wiov[2] = {
      {.iov_base = w1, .iov_len = sizeof(w1) - 1},
      {.iov_base = w2, .iov_len = sizeof(w2) - 1},
  };
  require(pwritev2(rw_fd, wiov, 2, 0, 0) == 11, "pwritev2 offset 0");

  struct iovec wiov_app = {.iov_base = w3, .iov_len = sizeof(w3) - 1};
  require(pwritev2(rw_fd, &wiov_app, 1, 0, RWF_APPEND) == 5,
          "pwritev2 RWF_APPEND");

  char r1[6];
  char r2[10];
  struct iovec riov[2] = {
      {.iov_base = r1, .iov_len = sizeof(r1)},
      {.iov_base = r2, .iov_len = sizeof(r2)},
  };
  require(preadv2(rw_fd, riov, 2, 0, 0) == 16, "preadv2 gather");
  require(memcmp(r1, "alpha-", 6) == 0 && memcmp(r2, "beta-gamma", 10) == 0,
          "preadv2 payload match");
  require(preadv2(rw_fd, riov, 2, 0, 0x40000000) == -1 && errno == EOPNOTSUPP,
          "preadv2 invalid flag EOPNOTSUPP");
  require(close(rw_fd) == 0, "close iov2.bin");

  int fd =
      open("/mnt/falloc.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(fd >= 0, "open(/mnt/falloc.bin)");
  require(fallocate(fd, 0, 0, 16384) == 0, "fallocate(0, 0, 16384)");

  uint8_t *pat = malloc(16384U);
  uint8_t *chk = malloc(16384U);
  require(pat != NULL && chk != NULL, "malloc 16384");
  for (size_t i = 0; i < 16384U; i++) {
    pat[i] = (uint8_t)(((i * 29U) + 1U) & 0xffU);
    if (pat[i] == 0U) {
      pat[i] = 1U;
    }
  }
  require(pwrite(fd, pat, 16384U, 0) == 16384, "pwrite 4 pages");
  require(fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 4096,
                    4096) == 0,
          "fallocate(PUNCH_HOLE)");

  require(lseek(fd, 0, SEEK_HOLE) == 4096, "lseek(0, SEEK_HOLE) == 4096");
  require(lseek(fd, 4096, SEEK_DATA) == 8192, "lseek(4096, SEEK_DATA) == 8192");

  require(pread(fd, chk, 4096, 4096) == 4096, "pread punched page");
  for (size_t i = 0; i < 4096U; i++) {
    require(chk[i] == 0U, "punched page zeroed");
  }

  require(ftruncate(fd, 2048) == 0, "ftruncate shrink 2048");
  require(ftruncate(fd, 6144) == 0, "ftruncate extend 6144");
  require(pread(fd, chk, 4096, 2048) == 4096, "pread extended tail");
  for (size_t i = 0; i < 4096U; i++) {
    require(chk[i] == 0U, "extended tail zero-filled");
  }
  require(close(fd) == 0, "close falloc.bin");

  int sf_src =
      open("/tmp/sf_src.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  int sf_dst =
      open("/tmp/sf_dst.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(sf_src >= 0 && sf_dst >= 0, "open sf_src/sf_dst");
  require(pwrite(sf_src, pat, 16384U, 0) == 16384, "pwrite sf_src");

  off_t off = 4096;
  size_t rem = 8192U;
  while (rem > 0) {
    ssize_t sn = sendfile(sf_dst, sf_src, &off, rem);
    require(sn > 0, "sendfile");
    rem -= (size_t)sn;
  }
  require(off == 12288, "sendfile off == 12288");
  require(pread(sf_dst, chk, 8192U, 0) == 8192, "pread sf_dst");
  require(memcmp(chk, pat + 4096, 8192U) == 0, "sendfile payload match");

  free(chk);
  free(pat);
  require(close(sf_dst) == 0, "close sf_dst");
  require(close(sf_src) == 0, "close sf_src");
  require(unlink("/tmp/sf_dst.bin") == 0, "unlink sf_dst");
  require(unlink("/tmp/sf_src.bin") == 0, "unlink sf_src");
  require(unlink("/mnt/falloc.bin") == 0, "unlink falloc.bin");
  require(unlink("/mnt/iov2.bin") == 0, "unlink iov2.bin");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("preadv2-pwritev2-fallocate-runtime: ok off=%lld\n", (long long)off);
  return 0;
}
