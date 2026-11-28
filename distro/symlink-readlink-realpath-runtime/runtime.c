#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

int main(void) {
  const char *root = "/tmp/symtest_root";
  const char *dir = "/tmp/symtest_root/dir";
  const char *sub = "/tmp/symtest_root/sub";
  const char *target = "/tmp/symtest_root/dir/target.txt";
  const char *rel_link = "/tmp/symtest_root/dir/rel_link";
  const char *nested_path = "/tmp/symtest_root/sub/../sub/nested_link";
  const char *dangling = "/tmp/symtest_root/dangling";
  const char *loop_a = "/tmp/symtest_root/loop_a";
  const char *loop_b = "/tmp/symtest_root/loop_b";
  int fd, sub_dfd;
  char buf[64], small[4], canon[PATH_MAX], resolved[PATH_MAX];
  ssize_t n;
  struct stat lst, st, st_target;

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");
  if (mkdir(root, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(root)");
  if (mkdir(dir, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(dir)");
  if (mkdir(sub, 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(sub)");

  unlink(rel_link);
  unlink(dangling);
  unlink(loop_a);
  unlink(loop_b);
  unlink(target);

  fd = open(target, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0 || write(fd, "sym-payload", 11) != 11 || close(fd) != 0)
    return fail_errno("setup target.txt");

  if (symlink("target.txt", rel_link) != 0)
    return fail_errno("symlink(rel_link)");
  if (symlink("no_such_file", dangling) != 0)
    return fail_errno("symlink(dangling)");
  if (symlink("loop_b", loop_a) != 0 || symlink("loop_a", loop_b) != 0)
    return fail_errno("symlink(loops)");

  sub_dfd = open(sub, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (sub_dfd < 0)
    return fail_errno("open(sub)");
  unlinkat(sub_dfd, "nested_link", 0);
  if (symlinkat("../dir/rel_link", sub_dfd, "nested_link") != 0)
    return fail_errno("symlinkat(nested_link)");

  /* 1. readlink must not NUL-terminate; verify exact length and truncation. */
  memset(buf, 0xaa, sizeof(buf));
  n = readlink(rel_link, buf, sizeof(buf));
  if (n != 10 || memcmp(buf, "target.txt", 10) != 0 ||
      (unsigned char)buf[10] != 0xaaU) {
    fprintf(stderr, "FAIL: readlink(rel_link) n=%zd\n", n);
    return 1;
  }

  memset(small, 0xbb, sizeof(small));
  n = readlink(rel_link, small, sizeof(small));
  if (n != 4 || memcmp(small, "targ", 4) != 0) {
    fprintf(stderr, "FAIL: readlink(small) n=%zd\n", n);
    return 1;
  }

  memset(buf, 0xaa, sizeof(buf));
  n = readlinkat(sub_dfd, "nested_link", buf, sizeof(buf));
  if (n != 15 || memcmp(buf, "../dir/rel_link", 15) != 0 ||
      (unsigned char)buf[15] != 0xaaU) {
    fprintf(stderr, "FAIL: readlinkat(nested_link) n=%zd\n", n);
    return 1;
  }

  /* 2. lstat vs stat on rel_link and dangling. */
  if (stat(target, &st_target) != 0)
    return fail_errno("stat(target)");
  if (lstat(rel_link, &lst) != 0 || !S_ISLNK(lst.st_mode)) {
    fprintf(stderr, "FAIL: lstat(rel_link) not symlink\n");
    return 1;
  }
  if (stat(rel_link, &st) != 0 || !S_ISREG(st.st_mode) ||
      st.st_ino != st_target.st_ino || st.st_dev != st_target.st_dev) {
    fprintf(stderr, "FAIL: stat(rel_link) did not follow to target\n");
    return 1;
  }

  if (lstat(dangling, &lst) != 0 || !S_ISLNK(lst.st_mode)) {
    fprintf(stderr, "FAIL: lstat(dangling) not symlink\n");
    return 1;
  }
  errno = 0;
  if (stat(dangling, &st) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: stat(dangling) expected ENOENT, errno=%d\n", errno);
    return 1;
  }

  /* 3. realpath across nested symlinks and '..'. */
  if (!realpath(target, canon))
    return fail_errno("realpath(target)");
  if (!realpath(nested_path, resolved))
    return fail_errno("realpath(nested_path)");
  if (strcmp(resolved, canon) != 0) {
    fprintf(stderr, "FAIL: realpath='%s', expected '%s'\n", resolved, canon);
    return 1;
  }

  /* 4. Error bounds: ELOOP, ENOENT, ENOTDIR, EINVAL. */
  errno = 0;
  if (stat(loop_a, &st) != -1 || errno != ELOOP) {
    fprintf(stderr, "FAIL: stat(loop_a) expected ELOOP, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (realpath(loop_a, resolved) != NULL || errno != ELOOP) {
    fprintf(stderr, "FAIL: realpath(loop_a) expected ELOOP, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (readlink("/tmp/symtest_root/missing", buf, sizeof(buf)) != -1 ||
      errno != ENOENT) {
    fprintf(stderr, "FAIL: readlink(ENOENT) errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (readlink("/tmp/symtest_root/dir/target.txt/child", buf, sizeof(buf)) != -1 ||
      errno != ENOTDIR) {
    fprintf(stderr, "FAIL: readlink(ENOTDIR) errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (readlink(target, buf, sizeof(buf)) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: readlink(regular file) expected EINVAL, errno=%d\n",
            errno);
    return 1;
  }

  if (unlinkat(sub_dfd, "nested_link", 0) != 0 || close(sub_dfd) != 0 ||
      unlink(rel_link) != 0 || unlink(dangling) != 0 ||
      unlink(loop_a) != 0 || unlink(loop_b) != 0 || unlink(target) != 0 ||
      rmdir(sub) != 0 || rmdir(dir) != 0 || rmdir(root) != 0)
    return fail_errno("cleanup");

  printf("symlink-readlink-realpath-runtime: PASS\n");
  return 0;
}
