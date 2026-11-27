#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int is_wouldblock(int err) {
  return err == EAGAIN || err == EWOULDBLOCK;
}

static void init_flock(struct flock *fl, short type, off_t start, off_t len) {
  memset(fl, 0, sizeof(*fl));
  fl->l_type = type;
  fl->l_whence = SEEK_SET;
  fl->l_start = start;
  fl->l_len = len;
  fl->l_pid = 0;
}

static int check_ofd_probe(int fd, off_t start, off_t len, short expected,
                           const char *label) {
  struct flock probe;
  init_flock(&probe, F_WRLCK, start, len);
  if (fcntl(fd, F_OFD_GETLK, &probe) != 0)
    return fail_errno(label);
  if (probe.l_type != expected) {
    fprintf(stderr, "FAIL: %s probe l_type=%d, expected %d\n",
            label, (int)probe.l_type, (int)expected);
    return 1;
  }
  return 0;
}

static int test_flock(int fd1, int fd2) {
  if (flock(fd1, LOCK_EX | LOCK_NB) != 0)
    return fail_errno("flock(fd1, LOCK_EX|LOCK_NB)");

  errno = 0;
  if (flock(fd2, LOCK_EX | LOCK_NB) != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: flock(fd2, LOCK_EX|LOCK_NB) expected EWOULDBLOCK, errno=%d\n",
            errno);
    return 1;
  }

  errno = 0;
  if (flock(fd2, LOCK_SH | LOCK_NB) != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: flock(fd2, LOCK_SH|LOCK_NB) expected EWOULDBLOCK, errno=%d\n",
            errno);
    return 1;
  }

  if (flock(fd1, LOCK_SH | LOCK_NB) != 0)
    return fail_errno("flock(fd1, LOCK_SH|LOCK_NB downgrade)");
  if (flock(fd2, LOCK_SH | LOCK_NB) != 0)
    return fail_errno("flock(fd2, LOCK_SH|LOCK_NB coexist)");

  errno = 0;
  if (flock(fd1, LOCK_EX | LOCK_NB) != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: flock(fd1, LOCK_EX|LOCK_NB) with fd2 SH, errno=%d\n",
            errno);
    return 1;
  }

  if (flock(fd2, LOCK_UN) != 0)
    return fail_errno("flock(fd2, LOCK_UN)");
  if (flock(fd1, LOCK_EX | LOCK_NB) != 0)
    return fail_errno("flock(fd1, LOCK_EX|LOCK_NB after fd2 unlock)");
  if (flock(fd1, LOCK_UN) != 0)
    return fail_errno("flock(fd1, LOCK_UN)");

  printf("flock: ok\n");
  return 0;
}

static int test_posix_and_ofd_fcntl(int fd1, int fd2) {
  struct flock fl, probe;

  /* Same-process POSIX fcntl locks do not conflict with each other. */
  init_flock(&fl, F_WRLCK, 0, 64);
  if (fcntl(fd1, F_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_SETLK, F_WRLCK)");

  init_flock(&probe, F_WRLCK, 0, 64);
  if (fcntl(fd2, F_GETLK, &probe) != 0)
    return fail_errno("fcntl(fd2, F_GETLK)");
  if (probe.l_type != F_UNLCK) {
    fprintf(stderr, "FAIL: same-process POSIX F_GETLK got l_type=%d\n",
            (int)probe.l_type);
    return 1;
  }

  init_flock(&fl, F_UNLCK, 0, 64);
  if (fcntl(fd1, F_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_SETLK, F_UNLCK)");

  /* OFD locks conflict across independent open file descriptions. */
  init_flock(&fl, F_WRLCK, 0, 64);
  if (fcntl(fd1, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_OFD_SETLK, F_WRLCK [0,64))");

  if (check_ofd_probe(fd2, 0, 64, F_WRLCK, "OFD probe [0,64)") != 0)
    return 1;

  init_flock(&fl, F_WRLCK, 0, 64);
  errno = 0;
  if (fcntl(fd2, F_OFD_SETLK, &fl) != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: fd2 F_OFD_SETLK conflict expected EAGAIN, errno=%d\n",
            errno);
    return 1;
  }

  /* Unlock middle range [16, 32) to split [0, 64) into [0, 16) and [32, 64). */
  init_flock(&fl, F_UNLCK, 16, 16);
  if (fcntl(fd1, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_OFD_SETLK, F_UNLCK [16,32))");

  if (check_ofd_probe(fd2, 0, 16, F_WRLCK, "OFD split [0,16)") != 0)
    return 1;
  if (check_ofd_probe(fd2, 16, 16, F_UNLCK, "OFD split [16,32)") != 0)
    return 1;
  if (check_ofd_probe(fd2, 32, 32, F_WRLCK, "OFD split [32,64)") != 0)
    return 1;

  init_flock(&fl, F_WRLCK, 16, 16);
  if (fcntl(fd2, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd2, F_OFD_SETLK, F_WRLCK [16,32))");
  init_flock(&fl, F_UNLCK, 16, 16);
  if (fcntl(fd2, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd2, F_OFD_SETLK, F_UNLCK [16,32))");

  /* Re-lock [16, 32) on fd1 to merge, then release [0, 64). */
  init_flock(&fl, F_WRLCK, 16, 16);
  if (fcntl(fd1, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_OFD_SETLK, merge [16,32))");
  init_flock(&fl, F_UNLCK, 0, 64);
  if (fcntl(fd1, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd1, F_OFD_SETLK, F_UNLCK [0,64))");

  init_flock(&fl, F_WRLCK, 0, 64);
  if (fcntl(fd2, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd2, F_OFD_SETLK, F_WRLCK after release)");
  init_flock(&fl, F_UNLCK, 0, 64);
  if (fcntl(fd2, F_OFD_SETLK, &fl) != 0)
    return fail_errno("fcntl(fd2, F_OFD_SETLK, final F_UNLCK)");

  printf("posix_ofd_fcntl: ok\n");
  return 0;
}

int main(void) {
  const char *path = "/tmp/flock-fcntl-lock-test.dat";
  char payload[64];
  int fd1, fd2;

  memset(payload, 'L', sizeof(payload));
  fd1 = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd1 < 0)
    return fail_errno("open(fd1)");
  if (write(fd1, payload, sizeof(payload)) != (ssize_t)sizeof(payload))
    return fail_errno("write(payload)");

  fd2 = open(path, O_RDWR | O_CLOEXEC);
  if (fd2 < 0)
    return fail_errno("open(fd2)");

  if (test_flock(fd1, fd2) != 0)
    return 1;
  if (test_posix_and_ofd_fcntl(fd1, fd2) != 0)
    return 1;

  if (close(fd2) != 0 || close(fd1) != 0)
    return fail_errno("close(fds)");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("flock-fcntl-lock-runtime: PASS\n");
  return 0;
}
