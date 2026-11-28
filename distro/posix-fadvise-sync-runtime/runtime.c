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

static int test_fadvise(int fd, int pipe_fd) {
  static const int advices[] = {
    POSIX_FADV_NORMAL,
    POSIX_FADV_SEQUENTIAL,
    POSIX_FADV_RANDOM,
    POSIX_FADV_WILLNEED,
    POSIX_FADV_DONTNEED,
    POSIX_FADV_NOREUSE,
  };
  int rc;

  for (size_t i = 0; i < sizeof(advices) / sizeof(advices[0]); ++i) {
    rc = posix_fadvise(fd, 0, 4096, advices[i]);
    if (rc != 0) {
      fprintf(stderr, "FAIL: posix_fadvise(advice=%d) returned %d\n",
              advices[i], rc);
      return 1;
    }
  }

  rc = posix_fadvise(pipe_fd, 0, 4096, POSIX_FADV_NORMAL);
  if (rc != ESPIPE) {
    fprintf(stderr, "FAIL: posix_fadvise(pipe) expected ESPIPE, got %d\n", rc);
    return 1;
  }

  rc = posix_fadvise(-1, 0, 4096, POSIX_FADV_NORMAL);
  if (rc != EBADF) {
    fprintf(stderr, "FAIL: posix_fadvise(-1) expected EBADF, got %d\n", rc);
    return 1;
  }

  rc = posix_fadvise(fd, 0, -1, POSIX_FADV_NORMAL);
  if (rc != EINVAL) {
    fprintf(stderr, "FAIL: posix_fadvise(len=-1) expected EINVAL, got %d\n",
            rc);
    return 1;
  }

  rc = posix_fadvise(fd, 0, 4096, 9999);
  if (rc != EINVAL) {
    fprintf(stderr, "FAIL: posix_fadvise(bad advice) expected EINVAL, got %d\n",
            rc);
    return 1;
  }

  printf("posix_fadvise: ok\n");
  return 0;
}

static int test_readahead_and_sync(int fd, int pipe_fd) {
  if (readahead(fd, 0, 4096) != 0)
    return fail_errno("readahead(file)");

  errno = 0;
  if (readahead(pipe_fd, 0, 4096) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: readahead(pipe) expected EINVAL, errno=%d\n",
            errno);
    return 1;
  }

  errno = 0;
  if (readahead(-1, 0, 4096) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: readahead(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }

  if (fsync(fd) != 0)
    return fail_errno("fsync(file)");
  if (fdatasync(fd) != 0)
    return fail_errno("fdatasync(file)");
  if (sync_file_range(fd, 0, 4096,
                      SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE |
                      SYNC_FILE_RANGE_WAIT_AFTER) != 0)
    return fail_errno("sync_file_range(file)");
  if (syncfs(fd) != 0)
    return fail_errno("syncfs(file)");

  errno = 0;
  if (fsync(-1) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: fsync(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (fdatasync(-1) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: fdatasync(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (syncfs(-1) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: syncfs(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sync_file_range(-1, 0, 4096, 0) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: sync_file_range(-1) expected EBADF, errno=%d\n",
            errno);
    return 1;
  }
  errno = 0;
  if (sync_file_range(fd, -1, 4096, 0) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: sync_file_range(off=-1) expected EINVAL, errno=%d\n",
            errno);
    return 1;
  }
  errno = 0;
  if (sync_file_range(fd, 0, 4096, ~0U) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: sync_file_range(bad flags) expected EINVAL, errno=%d\n",
            errno);
    return 1;
  }

  printf("readahead_sync: ok\n");
  return 0;
}

int main(void) {
  const char *path = "/tmp/fadvise-sync-test.bin";
  char buf[8192];
  int fd, pfd[2];

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(file)");

  memset(buf, 'A', sizeof(buf));
  if (write(fd, buf, sizeof(buf)) != (ssize_t)sizeof(buf))
    return fail_errno("write(file)");

  if (pipe2(pfd, O_CLOEXEC) != 0)
    return fail_errno("pipe2");

  if (test_fadvise(fd, pfd[0]) != 0)
    return 1;
  if (test_readahead_and_sync(fd, pfd[0]) != 0)
    return 1;

  if (close(pfd[0]) != 0 || close(pfd[1]) != 0 || close(fd) != 0)
    return fail_errno("close");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("posix-fadvise-sync-runtime: PASS\n");
  return 0;
}
