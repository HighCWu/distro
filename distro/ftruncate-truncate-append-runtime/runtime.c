#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int verify_zero_range(int fd, off_t start, size_t len,
                             const char *label) {
  uint8_t buf[1024];
  size_t done = 0;

  while (done < len) {
    size_t chunk = len - done;
    if (chunk > sizeof(buf))
      chunk = sizeof(buf);
    ssize_t n = pread(fd, buf, chunk, start + (off_t)done);
    if (n != (ssize_t)chunk)
      return fail_errno(label);
    for (size_t i = 0; i < chunk; ++i) {
      if (buf[i] != 0) {
        fprintf(stderr, "FAIL: %s non-zero 0x%02x at %lld\n",
                label, buf[i], (long long)(start + (off_t)(done + i)));
        return 1;
      }
    }
    done += chunk;
  }
  return 0;
}

int main(void) {
  const char *path = "/tmp/ftrunc_test.dat";
  uint8_t init_data[32], rbuf[32];
  int fd, app_fd;
  struct stat st;

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");

  for (size_t i = 0; i < sizeof(init_data); ++i)
    init_data[i] = (uint8_t)(0x41U + i);

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(create)");
  if (write(fd, init_data, sizeof(init_data)) != (ssize_t)sizeof(init_data))
    return fail_errno("write(init)");

  /* 1. ftruncate shrink & extend. */
  if (ftruncate(fd, 12) != 0)
    return fail_errno("ftruncate(12)");
  if (fstat(fd, &st) != 0 || st.st_size != 12) {
    fprintf(stderr, "FAIL: fstat size=%lld after ftruncate(12)\n",
            (long long)st.st_size);
    return 1;
  }
  if (pread(fd, rbuf, 12, 0) != 12 || memcmp(rbuf, init_data, 12) != 0) {
    fprintf(stderr, "FAIL: pread after ftruncate(12) mismatch\n");
    return 1;
  }

  if (ftruncate(fd, 4096) != 0)
    return fail_errno("ftruncate(4096)");
  if (fstat(fd, &st) != 0 || st.st_size != 4096) {
    fprintf(stderr, "FAIL: fstat size=%lld after ftruncate(4096)\n",
            (long long)st.st_size);
    return 1;
  }
  if (verify_zero_range(fd, 12, 4096 - 12, "ftruncate extend zeros") != 0)
    return 1;

  /* 2. truncate shrink, extend, and shrink. */
  if (truncate(path, 20) != 0)
    return fail_errno("truncate(20)");
  if (stat(path, &st) != 0 || st.st_size != 20) {
    fprintf(stderr, "FAIL: stat size=%lld after truncate(20)\n",
            (long long)st.st_size);
    return 1;
  }
  if (truncate(path, 8192) != 0)
    return fail_errno("truncate(8192)");
  if (stat(path, &st) != 0 || st.st_size != 8192) {
    fprintf(stderr, "FAIL: stat size=%lld after truncate(8192)\n",
            (long long)st.st_size);
    return 1;
  }
  if (verify_zero_range(fd, 20, 8192 - 20, "truncate extend zeros") != 0)
    return 1;
  if (truncate(path, 16) != 0)
    return fail_errno("truncate(16)");
  if (stat(path, &st) != 0 || st.st_size != 16) {
    fprintf(stderr, "FAIL: stat size=%lld after truncate(16)\n",
            (long long)st.st_size);
    return 1;
  }

  /* 3. O_APPEND ignores lseek(0, SEEK_SET) and writes at EOF. */
  app_fd = open(path, O_RDWR | O_APPEND | O_CLOEXEC);
  if (app_fd < 0)
    return fail_errno("open(O_APPEND)");
  if (lseek(app_fd, 0, SEEK_SET) != 0)
    return fail_errno("lseek(app_fd, 0)");
  if (write(app_fd, "TAIL", 4) != 4)
    return fail_errno("write(O_APPEND)");
  if (fstat(app_fd, &st) != 0 || st.st_size != 20) {
    fprintf(stderr, "FAIL: O_APPEND size=%lld, expected 20\n",
            (long long)st.st_size);
    return 1;
  }
  if (pread(app_fd, rbuf, 4, 16) != 4 || memcmp(rbuf, "TAIL", 4) != 0) {
    fprintf(stderr, "FAIL: O_APPEND did not write at offset 16\n");
    return 1;
  }
  if (close(app_fd) != 0)
    return fail_errno("close(app_fd)");

  /* 4. pread/pwrite must not alter current file offset. */
  if (lseek(fd, 3, SEEK_SET) != 3)
    return fail_errno("lseek(fd, 3)");
  if (pwrite(fd, "XYZ", 3, 12) != 3)
    return fail_errno("pwrite(XYZ)");
  if (lseek(fd, 0, SEEK_CUR) != 3) {
    fprintf(stderr, "FAIL: pwrite altered fd offset\n");
    return 1;
  }
  if (pread(fd, rbuf, 3, 12) != 3 || memcmp(rbuf, "XYZ", 3) != 0) {
    fprintf(stderr, "FAIL: pread(XYZ) mismatch\n");
    return 1;
  }
  if (lseek(fd, 0, SEEK_CUR) != 3) {
    fprintf(stderr, "FAIL: pread altered fd offset\n");
    return 1;
  }

  /* 5. Error bounds: EINVAL (negative length) and ENOENT. */
  errno = 0;
  if (ftruncate(fd, -1) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: ftruncate(-1) expected EINVAL, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (truncate(path, -1) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: truncate(-1) expected EINVAL, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (truncate("/tmp/ftrunc_missing_file", 10) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: truncate(ENOENT) errno=%d\n", errno);
    return 1;
  }

  if (close(fd) != 0)
    return fail_errno("close(fd)");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("ftruncate-truncate-append-runtime: PASS\n");
  return 0;
}
