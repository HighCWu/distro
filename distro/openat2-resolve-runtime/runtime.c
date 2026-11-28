#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_openat2
#define SYS_openat2 437
#endif

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int sys_openat2(int dfd, const char *path, const struct open_how *how,
                       size_t size) {
  return (int)syscall(SYS_openat2, (long)dfd, path, how, (unsigned long)size);
}

static int check_read_fd(int fd, const char *expected, const char *label) {
  char buf[32];
  ssize_t n;
  memset(buf, 0, sizeof(buf));
  n = read(fd, buf, sizeof(buf) - 1);
  if (close(fd) != 0)
    return fail_errno("close(read_fd)");
  if (n < 0)
    return fail_errno(label);
  if (strcmp(buf, expected) != 0) {
    fprintf(stderr, "FAIL: %s got '%s', expected '%s'\n",
            label, buf, expected);
    return 1;
  }
  return 0;
}

int main(void) {
  const char *root = "/tmp/openat2-test";
  const char *sub = "/tmp/openat2-test/sub";
  const char *out_file = "/tmp/openat2-test/outside.txt";
  const char *in_file = "/tmp/openat2-test/sub/inner.txt";
  int sub_dfd, fd;
  struct open_how how;

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");
  if (mkdir(root, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(root)");
  if (mkdir(sub, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(sub)");

  fd = open(out_file, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0 || write(fd, "outside", 7) != 7 || close(fd) != 0)
    return fail_errno("setup outside.txt");

  fd = open(in_file, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0 || write(fd, "inner", 5) != 5 || close(fd) != 0)
    return fail_errno("setup inner.txt");

  sub_dfd = open(sub, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (sub_dfd < 0)
    return fail_errno("open(sub)");

  unlinkat(sub_dfd, "link_in", 0);
  unlinkat(sub_dfd, "link_out", 0);
  unlinkat(sub_dfd, "created.txt", 0);
  if (symlinkat("inner.txt", sub_dfd, "link_in") != 0 ||
      symlinkat("../outside.txt", sub_dfd, "link_out") != 0)
    return fail_errno("symlinkat");

  /* 1. RESOLVE_BENEATH allows inside, rejects escaping '..' and symlink. */
  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY | O_CLOEXEC;
  how.resolve = RESOLVE_BENEATH;
  fd = sys_openat2(sub_dfd, "inner.txt", &how, sizeof(how));
  if (fd < 0)
    return fail_errno("openat2(BENEATH inner)");
  if (check_read_fd(fd, "inner", "BENEATH inner") != 0)
    return 1;

  errno = 0;
  if (sys_openat2(sub_dfd, "../outside.txt", &how, sizeof(how)) != -1 ||
      errno != EXDEV) {
    fprintf(stderr, "FAIL: BENEATH ../outside.txt errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sys_openat2(sub_dfd, "link_out", &how, sizeof(how)) != -1 ||
      errno != EXDEV) {
    fprintf(stderr, "FAIL: BENEATH link_out errno=%d\n", errno);
    return 1;
  }

  /* 2. RESOLVE_IN_ROOT clamps leading '/' and '..' to sub_dfd. */
  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY | O_CLOEXEC;
  how.resolve = RESOLVE_IN_ROOT;
  fd = sys_openat2(sub_dfd, "/inner.txt", &how, sizeof(how));
  if (fd < 0)
    return fail_errno("openat2(IN_ROOT /inner)");
  if (check_read_fd(fd, "inner", "IN_ROOT /inner") != 0)
    return 1;

  fd = sys_openat2(sub_dfd, "/../../../inner.txt", &how, sizeof(how));
  if (fd < 0)
    return fail_errno("openat2(IN_ROOT /../../../inner)");
  if (check_read_fd(fd, "inner", "IN_ROOT /../../../inner") != 0)
    return 1;

  /* 3. RESOLVE_NO_SYMLINKS blocks symlinks with ELOOP, allows regular files. */
  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY | O_CLOEXEC;
  how.resolve = RESOLVE_NO_SYMLINKS;
  errno = 0;
  if (sys_openat2(sub_dfd, "link_in", &how, sizeof(how)) != -1 ||
      errno != ELOOP) {
    fprintf(stderr, "FAIL: NO_SYMLINKS link_in errno=%d\n", errno);
    return 1;
  }
  fd = sys_openat2(sub_dfd, "inner.txt", &how, sizeof(how));
  if (fd < 0)
    return fail_errno("openat2(NO_SYMLINKS inner)");
  if (check_read_fd(fd, "inner", "NO_SYMLINKS inner") != 0)
    return 1;

  /* 4. O_CREAT + mode and EINVAL boundary checks. */
  memset(&how, 0, sizeof(how));
  how.flags = O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC;
  how.mode = 0640;
  how.resolve = RESOLVE_BENEATH;
  fd = sys_openat2(sub_dfd, "created.txt", &how, sizeof(how));
  if (fd < 0)
    return fail_errno("openat2(O_CREAT)");
  if (close(fd) != 0)
    return fail_errno("close(created.txt)");

  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY;
  how.mode = 0644;
  errno = 0;
  if (sys_openat2(sub_dfd, "inner.txt", &how, sizeof(how)) != -1 ||
      errno != EINVAL) {
    fprintf(stderr, "FAIL: openat2(mode without O_CREAT) errno=%d\n", errno);
    return 1;
  }

  memset(&how, 0, sizeof(how));
  how.flags = O_RDONLY;
  how.resolve = ~0ULL;
  errno = 0;
  if (sys_openat2(sub_dfd, "inner.txt", &how, sizeof(how)) != -1 ||
      errno != EINVAL) {
    fprintf(stderr, "FAIL: openat2(bad resolve) errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (sys_openat2(sub_dfd, "inner.txt", &how, 0) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: openat2(size=0) errno=%d\n", errno);
    return 1;
  }

  if (unlinkat(sub_dfd, "created.txt", 0) != 0 ||
      unlinkat(sub_dfd, "link_out", 0) != 0 ||
      unlinkat(sub_dfd, "link_in", 0) != 0 ||
      unlinkat(sub_dfd, "inner.txt", 0) != 0 ||
      close(sub_dfd) != 0 ||
      unlink(out_file) != 0 || rmdir(sub) != 0 || rmdir(root) != 0)
    return fail_errno("cleanup");

  printf("openat2-resolve-runtime: PASS\n");
  return 0;
}
