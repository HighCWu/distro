#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/falloc.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int check_lseek(int fd, off_t offset, int whence, off_t expected,
                       const char *label) {
  off_t got = lseek(fd, offset, whence);
  if (got != expected) {
    fprintf(stderr, "FAIL: %s lseek(%lld, %d)=%lld, expected %lld (errno=%d)\n",
            label, (long long)offset, whence, (long long)got,
            (long long)expected, errno);
    return 1;
  }
  return 0;
}

static int verify_zero_range(int fd, off_t offset, size_t len) {
  char buf[4096];
  size_t done = 0;

  while (done < len) {
    size_t chunk = len - done;
    if (chunk > sizeof(buf))
      chunk = sizeof(buf);
    ssize_t n = pread(fd, buf, chunk, offset + (off_t)done);
    if (n != (ssize_t)chunk)
      return fail_errno("pread(punched)");
    for (size_t i = 0; i < chunk; ++i) {
      if (buf[i] != 0) {
        fprintf(stderr, "FAIL: non-zero byte 0x%02x at offset %lld\n",
                (unsigned char)buf[i], (long long)(offset + (off_t)(done + i)));
        return 1;
      }
    }
    done += chunk;
  }
  return 0;
}

int main(void) {
  const char *path = "/mnt/sparse-lseek-hole-test.bin";
  char block[4096];
  char region[32768];
  int fd;
  off_t got;

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open");

  memset(block, 0x41, sizeof(block));
  if (pwrite(fd, block, sizeof(block), 0) != (ssize_t)sizeof(block))
    return fail_errno("pwrite(0)");

  memset(block, 0x42, sizeof(block));
  if (pwrite(fd, block, sizeof(block), 64 * 4096) != (ssize_t)sizeof(block))
    return fail_errno("pwrite(256KiB)");

  if (ftruncate(fd, 128 * 4096) != 0)
    return fail_errno("ftruncate(512KiB)");

  if (check_lseek(fd, 0, SEEK_DATA, 0, "SEEK_DATA@0") != 0)
    return 1;
  if (check_lseek(fd, 0, SEEK_HOLE, 4096, "SEEK_HOLE@0") != 0)
    return 1;
  if (check_lseek(fd, 4096, SEEK_DATA, 262144, "SEEK_DATA@4096") != 0)
    return 1;
  if (check_lseek(fd, 262144, SEEK_HOLE, 266240, "SEEK_HOLE@262144") != 0)
    return 1;

  errno = 0;
  got = lseek(fd, 266240, SEEK_DATA);
  if (got != (off_t)-1 || errno != ENXIO) {
    fprintf(stderr, "FAIL: SEEK_DATA@266240 got=%lld errno=%d, expected -1/ENXIO\n",
            (long long)got, errno);
    return 1;
  }

  memset(region, 0x5a, sizeof(region));
  if (pwrite(fd, region, sizeof(region), 512 * 1024) != (ssize_t)sizeof(region))
    return fail_errno("pwrite(512KiB..544KiB)");

  if (fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
                520 * 1024, 8192) != 0) {
    if (errno == EOPNOTSUPP) {
      printf("punch_hole: skipped (EOPNOTSUPP)\n");
    } else {
      return fail_errno("fallocate(PUNCH_HOLE)");
    }
  } else {
    if (verify_zero_range(fd, 520 * 1024, 8192) != 0)
      return 1;
    if (check_lseek(fd, 512 * 1024, SEEK_HOLE, 520 * 1024,
                    "SEEK_HOLE@512KiB") != 0)
      return 1;
    if (check_lseek(fd, 520 * 1024, SEEK_DATA, 528 * 1024,
                    "SEEK_DATA@520KiB") != 0)
      return 1;
    printf("punch_hole: ok\n");
  }

  if (close(fd) != 0)
    return fail_errno("close");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("sparse-lseek-hole-runtime: PASS\n");
  return 0;
}
