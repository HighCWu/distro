#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/close_range.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_close_range
#define SYS_close_range 436
#endif
#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int sys_close_range(unsigned int first, unsigned int last,
                           unsigned int flags) {
  return (int)syscall(SYS_close_range, (unsigned long)first,
                      (unsigned long)last, (unsigned long)flags);
}

static int expect_fd_open(int fd, int want_cloexec, const char *label) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0)
    return fail_errno(label);
  if (want_cloexec && (flags & FD_CLOEXEC) == 0) {
    fprintf(stderr, "FAIL: %s fd=%d missing FD_CLOEXEC\n", label, fd);
    return 1;
  }
  if (!want_cloexec && (flags & FD_CLOEXEC) != 0) {
    fprintf(stderr, "FAIL: %s fd=%d unexpectedly has FD_CLOEXEC\n", label, fd);
    return 1;
  }
  return 0;
}

static int expect_fd_closed(int fd, const char *label) {
  errno = 0;
  if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: %s fd=%d still open (errno=%d)\n",
            label, fd, errno);
    return 1;
  }
  return 0;
}

int main(void) {
  int pfd[2];
  const int base = 40;
  int fd_low = base - 1;
  int fd_high = base + 5;
  int fd_dup3, fd_fdup, fd_unshare;

  if (pipe2(pfd, 0) != 0)
    return fail_errno("pipe2");

  /* Populate [base-1 .. base+5] with no FD_CLOEXEC initially. */
  if (dup2(pfd[0], fd_low) < 0 || dup2(pfd[1], fd_high) < 0)
    return fail_errno("dup2(guards)");
  for (int i = 0; i <= 4; ++i) {
    if (dup2(pfd[i & 1], base + i) < 0)
      return fail_errno("dup2(range)");
  }

  /* 1. CLOSE_RANGE_CLOEXEC on [base, base+4], leaving guards untouched. */
  if (sys_close_range((unsigned int)base, (unsigned int)(base + 4),
                      CLOSE_RANGE_CLOEXEC) != 0)
    return fail_errno("close_range(CLOEXEC)");

  if (expect_fd_open(fd_low, 0, "guard low after CLOEXEC") != 0 ||
      expect_fd_open(fd_high, 0, "guard high after CLOEXEC") != 0)
    return 1;
  for (int i = 0; i <= 4; ++i) {
    if (expect_fd_open(base + i, 1, "range after CLOEXEC") != 0)
      return 1;
  }

  /* 2. Close a hole in the middle, then close_range [base, base+4]. */
  if (close(base + 2) != 0)
    return fail_errno("close(hole)");
  if (sys_close_range((unsigned int)base, (unsigned int)(base + 4), 0) != 0)
    return fail_errno("close_range(0)");

  for (int i = 0; i <= 4; ++i) {
    if (expect_fd_closed(base + i, "range after close_range") != 0)
      return 1;
  }
  if (expect_fd_open(fd_low, 0, "guard low after close_range") != 0 ||
      expect_fd_open(fd_high, 0, "guard high after close_range") != 0)
    return 1;

  /* 3. Unbounded upper close_range [base+10, ~0U]. */
  if (dup2(pfd[0], base + 10) < 0 || dup2(pfd[1], base + 15) < 0)
    return fail_errno("dup2(high)");
  if (sys_close_range((unsigned int)(base + 10), ~0U, 0) != 0)
    return fail_errno("close_range(~0U)");
  if (expect_fd_closed(base + 10, "high+10") != 0 ||
      expect_fd_closed(base + 15, "high+15") != 0 ||
      expect_fd_open(fd_high, 0, "guard high after ~0U") != 0)
    return 1;

  /* 4. dup3(O_CLOEXEC), fcntl(F_DUPFD_CLOEXEC), and CLOSE_RANGE_UNSHARE. */
  fd_dup3 = dup3(pfd[0], base + 20, O_CLOEXEC);
  if (fd_dup3 < 0)
    return fail_errno("dup3(O_CLOEXEC)");
  if (expect_fd_open(fd_dup3, 1, "dup3(O_CLOEXEC)") != 0)
    return 1;

  fd_fdup = fcntl(pfd[1], F_DUPFD_CLOEXEC, (unsigned long)(base + 21));
  if (fd_fdup < 0)
    return fail_errno("fcntl(F_DUPFD_CLOEXEC)");
  if (expect_fd_open(fd_fdup, 1, "F_DUPFD_CLOEXEC") != 0)
    return 1;

  fd_unshare = dup2(pfd[0], base + 22);
  if (fd_unshare < 0)
    return fail_errno("dup2(unshare)");
  if (unshare(CLONE_FILES) != 0)
    return fail_errno("unshare(CLONE_FILES)");
  if (sys_close_range((unsigned int)fd_unshare, (unsigned int)fd_unshare,
                      CLOSE_RANGE_UNSHARE) != 0)
    return fail_errno("close_range(UNSHARE)");
  if (expect_fd_closed(fd_unshare, "after CLOSE_RANGE_UNSHARE") != 0)
    return 1;

  /* 5. Boundary checks: first > last -> EINVAL, invalid flags -> EINVAL. */
  errno = 0;
  if (sys_close_range((unsigned int)(base + 5), (unsigned int)base, 0) != -1 ||
      errno != EINVAL) {
    fprintf(stderr, "FAIL: close_range(first > last) errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sys_close_range((unsigned int)base, (unsigned int)base, ~0U) != -1 ||
      errno != EINVAL) {
    fprintf(stderr, "FAIL: close_range(bad flags) errno=%d\n", errno);
    return 1;
  }

  if (close(fd_dup3) != 0 || close(fd_fdup) != 0 ||
      close(fd_low) != 0 || close(fd_high) != 0 ||
      close(pfd[0]) != 0 || close(pfd[1]) != 0)
    return fail_errno("close(cleanup)");

  printf("close-range-runtime: PASS\n");
  return 0;
}
