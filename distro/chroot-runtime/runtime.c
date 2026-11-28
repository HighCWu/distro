#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int read_tag(const char *path, const char *expected) {
  char buf[32];
  ssize_t n;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return fail_errno(path);
  memset(buf, 0, sizeof(buf));
  n = read(fd, buf, sizeof(buf) - 1);
  if (close(fd) != 0)
    return fail_errno("close(tag)");
  if (n < 0)
    return fail_errno("read(tag)");
  if (strcmp(buf, expected) != 0) {
    fprintf(stderr, "FAIL: %s read '%s', expected '%s'\n",
            path, buf, expected);
    return 1;
  }
  return 0;
}

int main(void) {
  const char *root = "/tmp/chroot-root";
  const char *etc_dir = "/tmp/chroot-root/etc";
  const char *sub_dir = "/tmp/chroot-root/sub";
  const char *tag_file = "/tmp/chroot-root/etc/tag";
  const char *volatile null_path = NULL;
  int outside_fd, fd;
  char cwd[256];
  struct stat st;

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");
  if (mkdir(root, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp/chroot-root)");
  if (mkdir(etc_dir, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp/chroot-root/etc)");
  if (mkdir(sub_dir, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp/chroot-root/sub)");

  fd = open(tag_file, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(tag_file)");
  if (write(fd, "inside", 6) != 6)
    return fail_errno("write(tag_file)");
  if (close(fd) != 0)
    return fail_errno("close(tag_file)");

  outside_fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (outside_fd < 0)
    return fail_errno("open(/)");

  if (chdir("/") != 0)
    return fail_errno("chdir(/)");
  if (chroot(root) != 0)
    return fail_errno("chroot(root)");

  /* Before chdir("/") inside chroot, cwd is outside new root. */
  if (getcwd(cwd, sizeof(cwd)) != NULL) {
    if (strncmp(cwd, "(unreachable)", 13) != 0) {
      fprintf(stderr, "FAIL: unexpected pre-chdir cwd '%s'\n", cwd);
      return 1;
    }
  } else if (errno != ENOENT) {
    return fail_errno("getcwd(pre-chdir)");
  }

  if (chdir("/") != 0)
    return fail_errno("chdir(/) inside chroot");
  if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, "/") != 0) {
    fprintf(stderr, "FAIL: chroot getcwd='%s', expected '/'\n", cwd);
    return 1;
  }

  if (read_tag("/etc/tag", "inside") != 0)
    return 1;
  if (read_tag("/../../../etc/tag", "inside") != 0)
    return 1;

  errno = 0;
  if (stat("/tmp/chroot-root/etc/tag", &st) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: outside path reachable inside chroot (errno=%d)\n",
            errno);
    return 1;
  }

  if (chdir("/sub") != 0)
    return fail_errno("chdir(/sub)");
  if (read_tag("../etc/tag", "inside") != 0)
    return 1;

  /* Error bounds inside chroot. */
  errno = 0;
  if (chroot("/no-such-chroot-dir") != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: chroot(ENOENT) errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (chroot("/etc/tag") != -1 || errno != ENOTDIR) {
    fprintf(stderr, "FAIL: chroot(ENOTDIR) errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (chroot(null_path) != -1 || errno != EFAULT) {
    fprintf(stderr, "FAIL: chroot(EFAULT) errno=%d\n", errno);
    return 1;
  }

  /* Escape back to original root via outside_fd. */
  if (fchdir(outside_fd) != 0)
    return fail_errno("fchdir(outside_fd)");
  if (chroot(".") != 0)
    return fail_errno("chroot(.)");
  if (close(outside_fd) != 0)
    return fail_errno("close(outside_fd)");

  if (stat(tag_file, &st) != 0)
    return fail_errno("stat(tag_file after escape)");

  if (unlink(tag_file) != 0 || rmdir(sub_dir) != 0 ||
      rmdir(etc_dir) != 0 || rmdir(root) != 0)
    return fail_errno("cleanup");

  printf("chroot-runtime: PASS\n");
  return 0;
}
