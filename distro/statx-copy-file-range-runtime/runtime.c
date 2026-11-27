#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/uio.h>
#include <unistd.h>

#define EXT4_SUPER_MAGIC_VAL 0xEF53UL
#define SRC_BYTES 16384U
#define COPY_OFF_IN 4096U
#define COPY_OFF_OUT 2048U
#define COPY_LEN 8192U

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "statx-copy-file-range-runtime: %s (errno=%d: %s)\n", what,
          errno, strerror(errno));
  exit(1);
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext4", 0, NULL) == 0,
          "mount(/dev/vda, ext4)");

  struct statfs sfs;
  require(statfs("/mnt", &sfs) == 0, "statfs(/mnt)");
  require((unsigned long)sfs.f_type == EXT4_SUPER_MAGIC_VAL,
          "EXT4_SUPER_MAGIC");

  int src_fd =
      open("/mnt/src.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(src_fd >= 0, "open(/mnt/src.bin)");

  uint8_t *buf_a = malloc(8192U);
  uint8_t *buf_b = malloc(8192U);
  require(buf_a != NULL && buf_b != NULL, "malloc");
  for (size_t i = 0; i < 8192U; i++) {
    buf_a[i] = (uint8_t)((i * 37U + 11U) & 0xffU);
    buf_b[i] = (uint8_t)(((i + 8192U) * 37U + 11U) & 0xffU);
  }

  struct iovec wiov1 = {.iov_base = buf_a, .iov_len = 8192U};
  require(pwritev2(src_fd, &wiov1, 1, 0, RWF_DSYNC) == 8192,
          "pwritev2(RWF_DSYNC)");

  struct iovec wiov2 = {.iov_base = buf_b, .iov_len = 8192U};
  require(pwritev2(src_fd, &wiov2, 1, 0, RWF_APPEND) == 8192,
          "pwritev2(RWF_APPEND)");

  struct statx stx;
  memset(&stx, 0, sizeof(stx));
  require(statx(src_fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
                STATX_BASIC_STATS | STATX_BTIME, &stx) == 0,
          "statx(AT_EMPTY_PATH)");
  require((stx.stx_mask & STATX_SIZE) != 0 && stx.stx_size == SRC_BYTES,
          "statx size == 16384");
  require((stx.stx_mask & STATX_BTIME) != 0, "statx btime");

  int dst_fd =
      open("/mnt/dst.bin", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(dst_fd >= 0, "open(/mnt/dst.bin)");
  require(ftruncate(dst_fd, (off_t)COPY_OFF_OUT) == 0, "ftruncate dst");

  off_t off_in = (off_t)COPY_OFF_IN;
  off_t off_out = (off_t)COPY_OFF_OUT;
  size_t copied = 0;
  while (copied < COPY_LEN) {
    ssize_t n = copy_file_range(src_fd, &off_in, dst_fd, &off_out,
                                COPY_LEN - copied, 0);
    require(n > 0, "copy_file_range");
    copied += (size_t)n;
  }
  require(off_in == (off_t)(COPY_OFF_IN + COPY_LEN), "off_in advanced");
  require(off_out == (off_t)(COPY_OFF_OUT + COPY_LEN), "off_out advanced");

  uint8_t *chk = malloc(COPY_LEN);
  require(chk != NULL, "malloc chk");
  struct iovec riov = {.iov_base = chk, .iov_len = COPY_LEN};
  require(preadv2(dst_fd, &riov, 1, (off_t)COPY_OFF_OUT, 0) == (ssize_t)COPY_LEN,
          "preadv2(dst_fd)");
  for (size_t i = 0; i < COPY_LEN; i++) {
    uint8_t exp = (uint8_t)(((i + COPY_OFF_IN) * 37U + 11U) & 0xffU);
    require(chk[i] == exp, "copy_file_range payload match");
  }

  require(fallocate(src_fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 4096,
                    4096) == 0,
          "fallocate(PUNCH_HOLE | KEEP_SIZE)");
  memset(&stx, 0, sizeof(stx));
  require(statx(AT_FDCWD, "/mnt/src.bin", 0, STATX_SIZE, &stx) == 0,
          "statx after punch");
  require(stx.stx_size == SRC_BYTES, "statx size preserved after punch");

  uint8_t hole[4096];
  struct iovec hiov = {.iov_base = hole, .iov_len = sizeof(hole)};
  require(preadv2(src_fd, &hiov, 1, 4096, 0) == (ssize_t)sizeof(hole),
          "preadv2 hole");
  for (size_t i = 0; i < sizeof(hole); i++) {
    require(hole[i] == 0U, "punched hole zeroed");
  }

  free(chk);
  free(buf_a);
  free(buf_b);
  require(close(dst_fd) == 0, "close dst_fd");
  require(close(src_fd) == 0, "close src_fd");
  require(unlink("/mnt/dst.bin") == 0, "unlink dst.bin");
  require(unlink("/mnt/src.bin") == 0, "unlink src.bin");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("statx-copy-file-range-runtime: ok copied=%u size=%llu\n", COPY_LEN,
         (unsigned long long)stx.stx_size);
  return 0;
}
