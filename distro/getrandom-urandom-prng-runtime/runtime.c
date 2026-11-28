#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int is_all_same(const uint8_t *buf, size_t len) {
  for (size_t i = 1; i < len; ++i) {
    if (buf[i] != buf[0])
      return 0;
  }
  return 1;
}

static int read_exact(int fd, uint8_t *buf, size_t len, const char *label) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = read(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return fail_errno(label);
    }
    if (n == 0) {
      fprintf(stderr, "FAIL: %s unexpected EOF at %zu/%zu\n", label, off, len);
      return 1;
    }
    off += (size_t)n;
  }
  return 0;
}

static int test_getrandom_and_getentropy(void) {
  uint8_t b1[32], b2[32], big1[256], big2[256];
  ssize_t n;

  n = getrandom(b1, sizeof(b1), 0);
  if (n != (ssize_t)sizeof(b1))
    return fail_errno("getrandom(0)");
  if (is_all_same(b1, sizeof(b1))) {
    fprintf(stderr, "FAIL: getrandom(0) returned constant bytes\n");
    return 1;
  }

  n = getrandom(b2, sizeof(b2), GRND_NONBLOCK);
  if (n != (ssize_t)sizeof(b2))
    return fail_errno("getrandom(GRND_NONBLOCK)");
  if (is_all_same(b2, sizeof(b2)) || memcmp(b1, b2, sizeof(b1)) == 0) {
    fprintf(stderr, "FAIL: getrandom(GRND_NONBLOCK) bad/duplicate output\n");
    return 1;
  }

  n = getrandom(big1, sizeof(big1), 0);
  if (n != (ssize_t)sizeof(big1) || is_all_same(big1, sizeof(big1)))
    return fail_errno("getrandom(256)");

  if (getentropy(big2, sizeof(big2)) != 0)
    return fail_errno("getentropy(256)");
  if (is_all_same(big2, sizeof(big2)) ||
      memcmp(big1, big2, sizeof(big1)) == 0) {
    fprintf(stderr, "FAIL: getentropy(256) bad/duplicate output\n");
    return 1;
  }

  errno = 0;
  if (getrandom(NULL, 16, 0) != -1 || errno != EFAULT) {
    fprintf(stderr, "FAIL: getrandom(NULL) expected EFAULT, errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (getrandom(b1, 16, ~0U) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: getrandom(bad flags) expected EINVAL, errno=%d\n",
            errno);
    return 1;
  }

  printf("getrandom_getentropy: ok\n");
  return 0;
}

static int test_dev_urandom(void) {
  int fd;
  uint8_t u1[32], u2[32];

  fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return fail_errno("open(/dev/urandom)");

  if (read_exact(fd, u1, sizeof(u1), "read(/dev/urandom, 1)") != 0)
    return 1;
  if (read_exact(fd, u2, sizeof(u2), "read(/dev/urandom, 2)") != 0)
    return 1;

  if (is_all_same(u1, sizeof(u1)) || is_all_same(u2, sizeof(u2)) ||
      memcmp(u1, u2, sizeof(u1)) == 0) {
    fprintf(stderr, "FAIL: /dev/urandom returned constant/duplicate bytes\n");
    return 1;
  }

  if (close(fd) != 0)
    return fail_errno("close(/dev/urandom)");

  printf("dev_urandom: ok\n");
  return 0;
}

int main(void) {
  if (test_getrandom_and_getentropy() != 0)
    return 1;
  if (test_dev_urandom() != 0)
    return 1;
  printf("getrandom-urandom-prng-runtime: PASS\n");
  return 0;
}
