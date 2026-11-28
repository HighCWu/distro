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

static volatile sig_atomic_t g_usr1 = 0;
static volatile sig_atomic_t g_usr2 = 0;

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static void on_sigusr(int sig) {
  if (sig == SIGUSR1)
    g_usr1 = 1;
  else if (sig == SIGUSR2)
    g_usr2 = 1;
}

static int install_handlers(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_sigusr;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  if (sigaction(SIGUSR1, &sa, NULL) != 0)
    return fail_errno("sigaction(SIGUSR1)");
  if (sigaction(SIGUSR2, &sa, NULL) != 0)
    return fail_errno("sigaction(SIGUSR2)");
  return 0;
}

static int wait_child_zero(pid_t pid, const char *label) {
  int st = 0;
  pid_t rc;
  do {
    rc = waitpid(pid, &st, 0);
  } while (rc == -1 && errno == EINTR);
  if (rc != pid)
    return fail_errno(label);
  if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
    fprintf(stderr, "FAIL: %s exited abnormally (status=0x%x)\n", label, st);
    return 1;
  }
  return 0;
}

static int run_setsid_child(void) {
  pid_t me = getpid();
  pid_t sid = setsid();
  if (sid != me)
    return 2;
  if (getsid(0) != sid || getpgid(0) != sid || getpgrp() != sid)
    return 3;
  errno = 0;
  if (setsid() != -1 || errno != EPERM)
    return 4;
  return 0;
}

static int run_pgrp_child(const char *mode, const char *pgid_str,
                          const char *rdy_str, const char *quit_str) {
  pid_t target_pgid = (pid_t)strtol(pgid_str, NULL, 10);
  int rdy_fd = (int)strtol(rdy_str, NULL, 10);
  int quit_fd = (int)strtol(quit_str, NULL, 10);
  sigset_t empty_mask;
  char ch = 0;

  if (setpgid(0, target_pgid) != 0 || install_handlers() != 0)
    return 10;

  sigemptyset(&empty_mask);

  if (strcmp(mode, "outside") == 0) {
    if (sigprocmask(SIG_SETMASK, &empty_mask, NULL) != 0)
      return 31;
    if (write(rdy_fd, "R", 1) != 1)
      return 32;
    if (read(quit_fd, &ch, 1) != 1)
      return 33;
    return (g_usr1 || g_usr2) ? 34 : 0;
  }

  if (write(rdy_fd, "R", 1) != 1)
    return 11;
  while (!g_usr1 || !g_usr2)
    sigsuspend(&empty_mask);
  return 0;
}

static int spawn_self(const char *exe, char *const argv[], pid_t *out_pid) {
  int rc = posix_spawn(out_pid, exe, NULL, NULL, argv, environ);
  if (rc != 0) {
    errno = rc;
    return fail_errno("posix_spawn");
  }
  return 0;
}

static int test_setsid_contract(const char *exe) {
  pid_t pid = -1;
  char *argv[] = { (char *)exe, (char *)"--setsid-child", NULL };

  if (spawn_self(exe, argv, &pid) != 0)
    return 1;
  if (wait_child_zero(pid, "setsid child") != 0)
    return 1;

  printf("setsid_contract: ok\n");
  return 0;
}

static int test_pgrp_signals(const char *exe) {
  int rdy1[2], rdy2[2], rdy3[2], quit[2];
  sigset_t usr_mask, orig_mask;
  pid_t c1 = -1, c2 = -1, c_out = -1;
  char pgid_buf[32], rdy1_buf[16], rdy2_buf[16], rdy3_buf[16], quit_buf[16];
  char ch = 0;

  if (pipe(rdy1) != 0 || pipe(rdy2) != 0 ||
      pipe(rdy3) != 0 || pipe(quit) != 0)
    return fail_errno("pipe");

  sigemptyset(&usr_mask);
  sigaddset(&usr_mask, SIGUSR1);
  sigaddset(&usr_mask, SIGUSR2);
  if (sigprocmask(SIG_BLOCK, &usr_mask, &orig_mask) != 0)
    return fail_errno("sigprocmask(block)");

  snprintf(rdy1_buf, sizeof(rdy1_buf), "%d", rdy1[1]);
  snprintf(rdy2_buf, sizeof(rdy2_buf), "%d", rdy2[1]);
  snprintf(rdy3_buf, sizeof(rdy3_buf), "%d", rdy3[1]);
  snprintf(quit_buf, sizeof(quit_buf), "%d", quit[0]);

  {
    char *argv1[] = { (char *)exe, (char *)"--pgrp-child", (char *)"group",
                      (char *)"0", rdy1_buf, (char *)"-1", NULL };
    if (spawn_self(exe, argv1, &c1) != 0)
      return 1;
  }
  if (read(rdy1[0], &ch, 1) != 1 || ch != 'R')
    return fail_errno("read(rdy1)");
  if (getpgid(c1) != c1) {
    fprintf(stderr, "FAIL: c1 pgid=%ld != %ld\n",
            (long)getpgid(c1), (long)c1);
    return 1;
  }

  snprintf(pgid_buf, sizeof(pgid_buf), "%ld", (long)c1);
  {
    char *argv2[] = { (char *)exe, (char *)"--pgrp-child", (char *)"group",
                      pgid_buf, rdy2_buf, (char *)"-1", NULL };
    if (spawn_self(exe, argv2, &c2) != 0)
      return 1;
  }
  if (read(rdy2[0], &ch, 1) != 1 || ch != 'R')
    return fail_errno("read(rdy2)");
  if (getpgid(c2) != c1) {
    fprintf(stderr, "FAIL: c2 pgid=%ld != %ld\n",
            (long)getpgid(c2), (long)c1);
    return 1;
  }

  {
    char *argv3[] = { (char *)exe, (char *)"--pgrp-child", (char *)"outside",
                      (char *)"0", rdy3_buf, quit_buf, NULL };
    if (spawn_self(exe, argv3, &c_out) != 0)
      return 1;
  }
  if (read(rdy3[0], &ch, 1) != 1 || ch != 'R')
    return fail_errno("read(rdy3)");
  if (getpgid(c_out) != c_out || c_out == c1) {
    fprintf(stderr, "FAIL: c_out pgid=%ld c1=%ld\n",
            (long)getpgid(c_out), (long)c1);
    return 1;
  }

  if (kill(-c1, SIGUSR1) != 0)
    return fail_errno("kill(-c1, SIGUSR1)");
  if (killpg(c1, SIGUSR2) != 0)
    return fail_errno("killpg(c1, SIGUSR2)");

  if (wait_child_zero(c1, "c1") != 0 || wait_child_zero(c2, "c2") != 0)
    return 1;

  if (write(quit[1], "Q", 1) != 1)
    return fail_errno("write(quit)");
  if (wait_child_zero(c_out, "c_out") != 0)
    return 1;

  if (sigprocmask(SIG_SETMASK, &orig_mask, NULL) != 0)
    return fail_errno("sigprocmask(restore)");

  if (close(rdy1[0]) != 0 || close(rdy1[1]) != 0 ||
      close(rdy2[0]) != 0 || close(rdy2[1]) != 0 ||
      close(rdy3[0]) != 0 || close(rdy3[1]) != 0 ||
      close(quit[0]) != 0 || close(quit[1]) != 0)
    return fail_errno("close(pipes)");

  printf("pgrp_signals: ok (pgid=%ld)\n", (long)c1);
  return 0;
}

static int test_error_bounds(void) {
  errno = 0;
  if (kill(999999, 0) != -1 || errno != ESRCH) {
    fprintf(stderr, "FAIL: kill(999999, 0) expected ESRCH, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (killpg(999999, 0) != -1 || errno != ESRCH) {
    fprintf(stderr, "FAIL: killpg(999999, 0) expected ESRCH, errno=%d\n",
            errno);
    return 1;
  }
  errno = 0;
  if (getpgid(999999) != -1 || errno != ESRCH) {
    fprintf(stderr, "FAIL: getpgid(999999) expected ESRCH, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (getsid(999999) != -1 || errno != ESRCH) {
    fprintf(stderr, "FAIL: getsid(999999) expected ESRCH, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (setpgid(999999, 0) != -1 || errno != ESRCH) {
    fprintf(stderr, "FAIL: setpgid(999999, 0) expected ESRCH, errno=%d\n",
            errno);
    return 1;
  }

  printf("error_bounds: ok\n");
  return 0;
}

int main(int argc, char **argv) {
  const char *exe = (argc > 0 && argv[0]) ? argv[0] :
                    "/bin/process-group-session-runtime";

  if (argc >= 2 && strcmp(argv[1], "--setsid-child") == 0)
    return run_setsid_child();
  if (argc >= 6 && strcmp(argv[1], "--pgrp-child") == 0)
    return run_pgrp_child(argv[2], argv[3], argv[4], argv[5]);

  if (test_setsid_contract(exe) != 0)
    return 1;
  if (test_pgrp_signals(exe) != 0)
    return 1;
  if (test_error_bounds() != 0)
    return 1;
  printf("process-group-session-runtime: PASS\n");
  return 0;
}
