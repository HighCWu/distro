#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

int main(void) {
  const char *dir = "/tmp/perm-test";
  int dfd, fd;
  mode_t old_mask;
  struct stat st, st_after;
  struct timespec times[2];

  if (mkdir(dir, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp/perm-test)");

  dfd = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dfd < 0)
    return fail_errno("open(dir)");

  unlinkat(dfd, "file", 0);
  unlinkat(dfd, "sym", 0);
  unlinkat(dfd, "dangling", 0);

  old_mask = umask(0027);
  fd = openat(dfd, "file", O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0666);
  umask(old_mask);
  if (fd < 0)
    return fail_errno("openat(file)");

  if (fstat(fd, &st) != 0)
    return fail_errno("fstat(file)");
  if ((st.st_mode & 0777) != 0640) {
    fprintf(stderr, "FAIL: umask mode=0%o, expected 0640\n",
            (unsigned)(st.st_mode & 0777));
    return 1;
  }

  if (fchmod(fd, 0751) != 0)
    return fail_errno("fchmod(0751)");
  if (fstat(fd, &st) != 0)
    return fail_errno("fstat(after fchmod)");
  if ((st.st_mode & 0777) != 0751) {
    fprintf(stderr, "FAIL: fchmod mode=0%o, expected 0751\n",
            (unsigned)(st.st_mode & 0777));
    return 1;
  }

  if (faccessat(dfd, "file", R_OK | W_OK | X_OK, AT_EACCESS) != 0)
    return fail_errno("faccessat(0751, R|W|X, AT_EACCESS)");

  if (fchmodat(dfd, "file", 0644, 0) != 0)
    return fail_errno("fchmodat(0644)");
  if (fstat(fd, &st) != 0)
    return fail_errno("fstat(after fchmodat)");
  if ((st.st_mode & 0777) != 0644) {
    fprintf(stderr, "FAIL: fchmodat mode=0%o, expected 0644\n",
            (unsigned)(st.st_mode & 0777));
    return 1;
  }

  if (faccessat(dfd, "file", R_OK | W_OK, AT_EACCESS) != 0)
    return fail_errno("faccessat(0644, R|W, AT_EACCESS)");

  errno = 0;
  if (faccessat(dfd, "file", X_OK, AT_EACCESS) != -1 || errno != EACCES) {
    fprintf(stderr, "FAIL: faccessat(0644, X_OK) expected EACCES, errno=%d\n",
            errno);
    return 1;
  }

  if (symlinkat("file", dfd, "sym") != 0)
    return fail_errno("symlinkat(sym)");
  if (symlinkat("no-such-target", dfd, "dangling") != 0)
    return fail_errno("symlinkat(dangling)");

  if (faccessat(dfd, "sym", F_OK, AT_SYMLINK_NOFOLLOW) != 0)
    return fail_errno("faccessat(sym, AT_SYMLINK_NOFOLLOW)");
  if (faccessat(dfd, "dangling", F_OK, AT_SYMLINK_NOFOLLOW) != 0)
    return fail_errno("faccessat(dangling, AT_SYMLINK_NOFOLLOW)");

  errno = 0;
  if (faccessat(dfd, "dangling", F_OK, 0) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: faccessat(dangling, 0) expected ENOENT, errno=%d\n",
            errno);
    return 1;
  }

  errno = 0;
  if (openat(dfd, "sym", O_RDONLY | O_NOFOLLOW | O_CLOEXEC) != -1 ||
      errno != ELOOP) {
    fprintf(stderr, "FAIL: openat(sym, O_NOFOLLOW) expected ELOOP, errno=%d\n",
            errno);
    return 1;
  }

  /* Update mtime explicitly while leaving atime untouched via UTIME_OMIT. */
  if (fstat(fd, &st) != 0)
    return fail_errno("fstat(before utimensat)");

  times[0].tv_sec = 0;
  times[0].tv_nsec = UTIME_OMIT;
  times[1].tv_sec = 1700000123;
  times[1].tv_nsec = 456000000L;
  if (utimensat(dfd, "file", times, 0) != 0)
    return fail_errno("utimensat");

  if (fstat(fd, &st_after) != 0)
    return fail_errno("fstat(after utimensat)");

  if (st_after.st_atim.tv_sec != st.st_atim.tv_sec ||
      st_after.st_atim.tv_nsec != st.st_atim.tv_nsec) {
    fprintf(stderr, "FAIL: utimensat UTIME_OMIT altered atime\n");
    return 1;
  }
  if (st_after.st_mtim.tv_sec != 1700000123 ||
      st_after.st_mtim.tv_nsec != 456000000L) {
    fprintf(stderr, "FAIL: utimensat mtime=%lld.%09ld, expected 1700000123.456000000\n",
            (long long)st_after.st_mtim.tv_sec, st_after.st_mtim.tv_nsec);
    return 1;
  }

  if (close(fd) != 0)
    return fail_errno("close(file)");
  if (unlinkat(dfd, "dangling", 0) != 0 || unlinkat(dfd, "sym", 0) != 0 ||
      unlinkat(dfd, "file", 0) != 0)
    return fail_errno("unlinkat");
  if (close(dfd) != 0)
    return fail_errno("close(dfd)");
  if (rmdir(dir) != 0)
    return fail_errno("rmdir");

  printf("faccessat2-umask-chmod-utime-runtime: PASS\n");
  return 0;
}
