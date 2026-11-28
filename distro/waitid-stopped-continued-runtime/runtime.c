#define _GNU_SOURCE
#include <errno.h>
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

static int spawn_self(const char *exe, char *const argv[], pid_t *out_pid) {
  int rc = posix_spawn(out_pid, exe, NULL, NULL, argv, environ);
  if (rc != 0) {
    errno = rc;
    return fail_errno("posix_spawn");
  }
  return 0;
}

static int waitid_retry(idtype_t idtype, id_t id, siginfo_t *si, int options,
                        const char *label) {
  int rc;
  do {
    memset(si, 0, sizeof(*si));
    rc = waitid(idtype, id, si, options);
  } while (rc == -1 && errno == EINTR);
  if (rc != 0)
    return fail_errno(label);
  return 0;
}

static int waitpid_retry(pid_t pid, int *st, int options, const char *label) {
  pid_t rc;
  do {
    rc = waitpid(pid, st, options);
  } while (rc == -1 && errno == EINTR);
  if (rc != pid)
    return fail_errno(label);
  return 0;
}

static int run_wait_pipe_child(const char *rfd_str, const char *wfd_str) {
  int rfd = (int)strtol(rfd_str, NULL, 10);
  int wfd = (int)strtol(wfd_str, NULL, 10);
  char ch = 0;
  ssize_t n;

  if (write(wfd, "R", 1) != 1)
    return 11;

  for (;;) {
    n = read(rfd, &ch, 1);
    if (n < 0 && errno == EINTR)
      continue;
    if (n != 1 || ch != 'Q')
      return 12;
    break;
  }
  return 0;
}

static int test_waitid_nowait_echild(const char *exe) {
  pid_t pid = -1;
  siginfo_t si;
  char *argv[] = { (char *)exe, (char *)"--exit-42", NULL };

  if (spawn_self(exe, argv, &pid) != 0)
    return 1;

  if (waitid_retry(P_PID, (id_t)pid, &si, WEXITED | WNOWAIT,
                   "waitid(WNOWAIT)") != 0)
    return 1;
  if (si.si_pid != pid || si.si_code != CLD_EXITED || si.si_status != 42) {
    fprintf(stderr, "FAIL: WNOWAIT pid=%ld code=%d status=%d\n",
            (long)si.si_pid, si.si_code, si.si_status);
    return 1;
  }

  if (waitid_retry(P_PID, (id_t)pid, &si, WEXITED, "waitid(reap)") != 0)
    return 1;
  if (si.si_pid != pid || si.si_code != CLD_EXITED || si.si_status != 42) {
    fprintf(stderr, "FAIL: reap pid=%ld code=%d status=%d\n",
            (long)si.si_pid, si.si_code, si.si_status);
    return 1;
  }

  errno = 0;
  if (waitid(P_PID, (id_t)pid, &si, WEXITED) != -1 || errno != ECHILD) {
    fprintf(stderr, "FAIL: post-reap waitid expected ECHILD, errno=%d\n",
            errno);
    return 1;
  }

  printf("waitid_nowait: ok (pid=%ld)\n", (long)pid);
  return 0;
}

static int test_waitid_stop_cont(const char *exe) {
  int rdy[2], quit[2];
  char rfd_buf[16], wfd_buf[16], ch = 0;
  pid_t pid = -1;
  siginfo_t si;

  if (pipe(rdy) != 0 || pipe(quit) != 0)
    return fail_errno("pipe(waitid)");

  snprintf(rfd_buf, sizeof(rfd_buf), "%d", quit[0]);
  snprintf(wfd_buf, sizeof(wfd_buf), "%d", rdy[1]);
  {
    char *argv[] = { (char *)exe, (char *)"--wait-pipe", rfd_buf, wfd_buf,
                     NULL };
    if (spawn_self(exe, argv, &pid) != 0)
      return 1;
  }

  if (read(rdy[0], &ch, 1) != 1 || ch != 'R')
    return fail_errno("read(rdy waitid)");

  if (kill(pid, SIGSTOP) != 0)
    return fail_errno("kill(SIGSTOP waitid)");
  if (waitid_retry(P_PID, (id_t)pid, &si, WSTOPPED, "waitid(WSTOPPED)") != 0)
    return 1;
  if (si.si_pid != pid || si.si_code != CLD_STOPPED ||
      si.si_status != SIGSTOP) {
    fprintf(stderr, "FAIL: waitid WSTOPPED pid=%ld code=%d status=%d\n",
            (long)si.si_pid, si.si_code, si.si_status);
    return 1;
  }

  if (kill(pid, SIGCONT) != 0)
    return fail_errno("kill(SIGCONT waitid)");
  if (waitid_retry(P_PID, (id_t)pid, &si, WCONTINUED,
                   "waitid(WCONTINUED)") != 0)
    return 1;
  if (si.si_pid != pid || si.si_code != CLD_CONTINUED ||
      si.si_status != SIGCONT) {
    fprintf(stderr, "FAIL: waitid WCONTINUED pid=%ld code=%d status=%d\n",
            (long)si.si_pid, si.si_code, si.si_status);
    return 1;
  }

  if (write(quit[1], "Q", 1) != 1)
    return fail_errno("write(quit waitid)");
  if (waitid_retry(P_PID, (id_t)pid, &si, WEXITED, "waitid(exit)") != 0)
    return 1;
  if (si.si_pid != pid || si.si_code != CLD_EXITED || si.si_status != 0) {
    fprintf(stderr, "FAIL: waitid exit pid=%ld code=%d status=%d\n",
            (long)si.si_pid, si.si_code, si.si_status);
    return 1;
  }

  if (close(rdy[0]) != 0 || close(rdy[1]) != 0 ||
      close(quit[0]) != 0 || close(quit[1]) != 0)
    return fail_errno("close(pipes waitid)");

  printf("waitid_stop_cont: ok (pid=%ld)\n", (long)pid);
  return 0;
}

static int test_waitpid_stop_cont(const char *exe) {
  int rdy[2], quit[2];
  char rfd_buf[16], wfd_buf[16], ch = 0;
  pid_t pid = -1;
  int st = 0;

  if (pipe(rdy) != 0 || pipe(quit) != 0)
    return fail_errno("pipe(waitpid)");

  snprintf(rfd_buf, sizeof(rfd_buf), "%d", quit[0]);
  snprintf(wfd_buf, sizeof(wfd_buf), "%d", rdy[1]);
  {
    char *argv[] = { (char *)exe, (char *)"--wait-pipe", rfd_buf, wfd_buf,
                     NULL };
    if (spawn_self(exe, argv, &pid) != 0)
      return 1;
  }

  if (read(rdy[0], &ch, 1) != 1 || ch != 'R')
    return fail_errno("read(rdy waitpid)");

  if (kill(pid, SIGSTOP) != 0)
    return fail_errno("kill(SIGSTOP waitpid)");
  if (waitpid_retry(pid, &st, WUNTRACED, "waitpid(WUNTRACED)") != 0)
    return 1;
  if (!WIFSTOPPED(st) || WSTOPSIG(st) != SIGSTOP) {
    fprintf(stderr, "FAIL: waitpid WUNTRACED status=0x%x\n", st);
    return 1;
  }

  if (kill(pid, SIGCONT) != 0)
    return fail_errno("kill(SIGCONT waitpid)");
  if (waitpid_retry(pid, &st, WCONTINUED, "waitpid(WCONTINUED)") != 0)
    return 1;
  if (!WIFCONTINUED(st)) {
    fprintf(stderr, "FAIL: waitpid WCONTINUED status=0x%x\n", st);
    return 1;
  }

  if (write(quit[1], "Q", 1) != 1)
    return fail_errno("write(quit waitpid)");
  if (waitpid_retry(pid, &st, 0, "waitpid(exit)") != 0)
    return 1;
  if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) {
    fprintf(stderr, "FAIL: waitpid exit status=0x%x\n", st);
    return 1;
  }

  if (close(rdy[0]) != 0 || close(rdy[1]) != 0 ||
      close(quit[0]) != 0 || close(quit[1]) != 0)
    return fail_errno("close(pipes waitpid)");

  printf("waitpid_stop_cont: ok (pid=%ld)\n", (long)pid);
  return 0;
}

int main(int argc, char **argv) {
  const char *exe = (argc > 0 && argv[0]) ? argv[0] :
                    "/bin/waitid-stopped-continued-runtime";

  if (argc >= 2 && strcmp(argv[1], "--exit-42") == 0)
    return 42;
  if (argc >= 4 && strcmp(argv[1], "--wait-pipe") == 0)
    return run_wait_pipe_child(argv[2], argv[3]);

  if (test_waitid_nowait_echild(exe) != 0)
    return 1;
  if (test_waitid_stop_cont(exe) != 0)
    return 1;
  if (test_waitpid_stop_cont(exe) != 0)
    return 1;

  printf("waitid-stopped-continued-runtime: PASS\n");
  return 0;
}
