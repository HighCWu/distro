#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int expect_ebadf(int fd, const char *label) {
  errno = 0;
  if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: %s fd=%d leaked (errno=%d)\n", label, fd, errno);
    return 1;
  }
  return 0;
}

static int run_child(const char *closed_rfd_s, const char *clo_rfd_s,
                     const char *clo_wfd_s) {
  int closed_rfd = (int)strtol(closed_rfd_s, NULL, 10);
  int clo_rfd = (int)strtol(clo_rfd_s, NULL, 10);
  int clo_wfd = (int)strtol(clo_wfd_s, NULL, 10);
  sigset_t cur_mask;
  struct sigaction cur_sa;
  const char msg[] = "SPAWN_CHILD_OK\n";

  if (sigprocmask(SIG_SETMASK, NULL, &cur_mask) != 0)
    return 10;
  if (sigismember(&cur_mask, SIGUSR1)) {
    fprintf(stderr, "FAIL: child still has SIGUSR1 blocked\n");
    return 11;
  }

  memset(&cur_sa, 0, sizeof(cur_sa));
  if (sigaction(SIGUSR2, NULL, &cur_sa) != 0)
    return 12;
  if (cur_sa.sa_handler != SIG_DFL) {
    fprintf(stderr, "FAIL: child SIGUSR2 was not reset to SIG_DFL\n");
    return 13;
  }

  if (expect_ebadf(closed_rfd, "addclose(out_pipe[0])") != 0 ||
      expect_ebadf(clo_rfd, "O_CLOEXEC[0]") != 0 ||
      expect_ebadf(clo_wfd, "O_CLOEXEC[1]") != 0)
    return 14;

  if (write(7, msg, sizeof(msg) - 1) != (ssize_t)(sizeof(msg) - 1))
    return 15;

  return 0;
}

int main(int argc, char **argv) {
  const char *exe = (argc > 0 && argv[0]) ? argv[0] :
                    "/bin/posix-spawn-cloexec-sigmask-runtime";
  int out_pipe[2], clo_pipe[2];
  sigset_t usr1_mask, usr2_mask, empty_mask, orig_mask;
  struct sigaction ign_sa, old_sa;
  posix_spawn_file_actions_t fa;
  posix_spawnattr_t attr;
  char rfd_s[16], clo_r_s[16], clo_w_s[16];
  pid_t pid = -1;
  char buf[64];
  size_t off = 0;
  int st = 0, rc;

  if (argc >= 5 && strcmp(argv[1], "--child") == 0)
    return run_child(argv[2], argv[3], argv[4]);

  if (pipe(out_pipe) != 0)
    return fail_errno("pipe(out_pipe)");
  if (pipe2(clo_pipe, O_CLOEXEC) != 0)
    return fail_errno("pipe2(clo_pipe)");

  sigemptyset(&usr1_mask);
  sigaddset(&usr1_mask, SIGUSR1);
  sigemptyset(&usr2_mask);
  sigaddset(&usr2_mask, SIGUSR2);
  sigemptyset(&empty_mask);

  if (sigprocmask(SIG_BLOCK, &usr1_mask, &orig_mask) != 0)
    return fail_errno("sigprocmask(block SIGUSR1)");

  memset(&ign_sa, 0, sizeof(ign_sa));
  ign_sa.sa_handler = SIG_IGN;
  sigemptyset(&ign_sa.sa_mask);
  if (sigaction(SIGUSR2, &ign_sa, &old_sa) != 0)
    return fail_errno("sigaction(SIGUSR2, SIG_IGN)");

  if (posix_spawn_file_actions_init(&fa) != 0)
    return fail_errno("posix_spawn_file_actions_init");
  if (posix_spawn_file_actions_adddup2(&fa, out_pipe[1], 7) != 0 ||
      posix_spawn_file_actions_addclose(&fa, out_pipe[0]) != 0)
    return fail_errno("posix_spawn_file_actions_add*");
  if (out_pipe[1] != 7 &&
      posix_spawn_file_actions_addclose(&fa, out_pipe[1]) != 0)
    return fail_errno("posix_spawn_file_actions_addclose(out_pipe[1])");

  if (posix_spawnattr_init(&attr) != 0)
    return fail_errno("posix_spawnattr_init");
  if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK |
                                          POSIX_SPAWN_SETSIGDEF) != 0 ||
      posix_spawnattr_setsigmask(&attr, &empty_mask) != 0 ||
      posix_spawnattr_setsigdefault(&attr, &usr2_mask) != 0)
    return fail_errno("posix_spawnattr_set*");

  snprintf(rfd_s, sizeof(rfd_s), "%d", out_pipe[0]);
  snprintf(clo_r_s, sizeof(clo_r_s), "%d", clo_pipe[0]);
  snprintf(clo_w_s, sizeof(clo_w_s), "%d", clo_pipe[1]);

  {
    char *child_argv[] = { (char *)exe, (char *)"--child", rfd_s, clo_r_s,
                           clo_w_s, NULL };
    rc = posix_spawn(&pid, exe, &fa, &attr, child_argv, environ);
    if (rc != 0) {
      errno = rc;
      return fail_errno("posix_spawn");
    }
  }

  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&attr);

  if (close(out_pipe[1]) != 0)
    return fail_errno("close(out_pipe[1])");

  memset(buf, 0, sizeof(buf));
  while (off < sizeof(buf) - 1) {
    ssize_t n = read(out_pipe[0], buf + off, sizeof(buf) - 1 - off);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return fail_errno("read(out_pipe[0])");
    }
    if (n == 0)
      break;
    off += (size_t)n;
  }

  if (strcmp(buf, "SPAWN_CHILD_OK\n") != 0) {
    fprintf(stderr, "FAIL: unexpected child output '%s'\n", buf);
    return 1;
  }

  while (waitpid(pid, &st, 0) == -1 && errno == EINTR)
    ;
  if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
    fprintf(stderr, "FAIL: child exited abnormally (status=0x%x)\n", st);
    return 1;
  }

  if (sigaction(SIGUSR2, &old_sa, NULL) != 0)
    return fail_errno("sigaction(restore)");
  if (sigprocmask(SIG_SETMASK, &orig_mask, NULL) != 0)
    return fail_errno("sigprocmask(restore)");
  if (close(out_pipe[0]) != 0 || close(clo_pipe[0]) != 0 ||
      close(clo_pipe[1]) != 0)
    return fail_errno("close(cleanup)");

  printf("posix-spawn-cloexec-sigmask-runtime: PASS\n");
  return 0;
}
