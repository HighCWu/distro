#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int check_cloexec(int fd, int want, const char *label) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0)
    return fail_errno(label);
  if (want && (flags & FD_CLOEXEC) == 0) {
    fprintf(stderr, "FAIL: %s fd=%d missing FD_CLOEXEC\n", label, fd);
    return 1;
  }
  if (!want && (flags & FD_CLOEXEC) != 0) {
    fprintf(stderr, "FAIL: %s fd=%d unexpected FD_CLOEXEC\n", label, fd);
    return 1;
  }
  return 0;
}

static int run_child(const char *clo_s, const char *inh_s) {
  int clo_fd = (int)strtol(clo_s, NULL, 10);
  int inh_fd = (int)strtol(inh_s, NULL, 10);
  char buf[16];
  ssize_t n;

  errno = 0;
  if (fcntl(clo_fd, F_GETFD) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: child clo_fd=%d leaked (errno=%d)\n",
            clo_fd, errno);
    return 10;
  }

  if (fcntl(inh_fd, F_GETFD) < 0)
    return 11;

  memset(buf, 0, sizeof(buf));
  n = read(inh_fd, buf, sizeof(buf) - 1);
  if (n != 8 || memcmp(buf, "ABCD1234", 8) != 0) {
    fprintf(stderr, "FAIL: child read n=%zd buf='%s'\n", n, buf);
    return 12;
  }
  return 0;
}

int main(int argc, char **argv) {
  const char *exe = (argc > 0 && argv[0]) ? argv[0] :
                    "/bin/fcntl-dupfd-cloexec-flags-runtime";
  const char *path = "/tmp/dupfd-test.dat";
  int fd, d_dup, d_dup2, d_dup3, d_fdup, d_fdup_clo;
  char clo_s[16], inh_s[16];
  pid_t pid = -1;
  int st = 0, rc;

  if (argc >= 4 && strcmp(argv[1], "--child") == 0)
    return run_child(argv[2], argv[3]);

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(O_CLOEXEC)");
  if (check_cloexec(fd, 1, "open(O_CLOEXEC)") != 0)
    return 1;

  d_dup = dup(fd);
  if (d_dup < 0)
    return fail_errno("dup");
  if (check_cloexec(d_dup, 0, "dup") != 0)
    return 1;

  d_dup2 = dup2(fd, 40);
  if (d_dup2 != 40)
    return fail_errno("dup2(40)");
  if (check_cloexec(d_dup2, 0, "dup2(40)") != 0)
    return 1;
  if (dup2(d_dup2, 40) != 40)
    return fail_errno("dup2(40, 40)");

  d_dup3 = dup3(fd, 41, O_CLOEXEC);
  if (d_dup3 != 41)
    return fail_errno("dup3(41, O_CLOEXEC)");
  if (check_cloexec(d_dup3, 1, "dup3(41, O_CLOEXEC)") != 0)
    return 1;
  errno = 0;
  if (dup3(d_dup3, 41, O_CLOEXEC) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: dup3(41, 41) expected EINVAL, errno=%d\n", errno);
    return 1;
  }

  d_fdup = fcntl(fd, F_DUPFD, 50UL);
  if (d_fdup < 50)
    return fail_errno("fcntl(F_DUPFD, 50)");
  if (check_cloexec(d_fdup, 0, "F_DUPFD") != 0)
    return 1;

  d_fdup_clo = fcntl(fd, F_DUPFD_CLOEXEC, 60UL);
  if (d_fdup_clo < 60)
    return fail_errno("fcntl(F_DUPFD_CLOEXEC, 60)");
  if (check_cloexec(d_fdup_clo, 1, "F_DUPFD_CLOEXEC") != 0)
    return 1;

  /* Shared OFD offset advances across all dup'd descriptors. */
  if (write(fd, "ABCD1234", 8) != 8)
    return fail_errno("write");
  if (lseek(d_dup, 0, SEEK_CUR) != 8 || lseek(d_fdup, 0, SEEK_CUR) != 8) {
    fprintf(stderr, "FAIL: shared OFD offset mismatch\n");
    return 1;
  }

  /* FD_CLOEXEC is per-descriptor and independent across dups. */
  if (fcntl(fd, F_SETFD, 0UL) != 0)
    return fail_errno("fcntl(fd, F_SETFD, 0)");
  if (check_cloexec(d_dup3, 1, "d_dup3 independent") != 0 ||
      check_cloexec(d_fdup_clo, 1, "d_fdup_clo independent") != 0)
    return 1;
  if (fcntl(fd, F_SETFD, (unsigned long)FD_CLOEXEC) != 0)
    return fail_errno("fcntl(fd, F_SETFD, FD_CLOEXEC)");
  if (check_cloexec(d_dup, 0, "d_dup independent") != 0 ||
      check_cloexec(d_dup2, 0, "d_dup2 independent") != 0 ||
      check_cloexec(d_fdup, 0, "d_fdup independent") != 0)
    return 1;

  if (lseek(fd, 0, SEEK_SET) != 0)
    return fail_errno("lseek(0)");

  snprintf(clo_s, sizeof(clo_s), "%d", d_dup3);
  snprintf(inh_s, sizeof(inh_s), "%d", d_fdup);
  {
    char *child_argv[] = { (char *)exe, (char *)"--child", clo_s, inh_s, NULL };
    rc = posix_spawn(&pid, exe, NULL, NULL, child_argv, environ);
    if (rc != 0) {
      errno = rc;
      return fail_errno("posix_spawn");
    }
  }

  while (waitpid(pid, &st, 0) == -1 && errno == EINTR)
    ;
  if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
    fprintf(stderr, "FAIL: child exited abnormally (status=0x%x)\n", st);
    return 1;
  }

  if (close(d_fdup_clo) != 0 || close(d_fdup) != 0 || close(d_dup3) != 0 ||
      close(d_dup2) != 0 || close(d_dup) != 0 || close(fd) != 0)
    return fail_errno("close");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("fcntl-dupfd-cloexec-flags-runtime: PASS\n");
  return 0;
}
