// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static int prepares, parents, children, global_value = 31;
static _Thread_local volatile int tls_value = 41;
static void prepare(void) { prepares++; }
static void parent(void) { parents++; }
static void child(void) { children++; }
static void require(int ok, const char *message)
{
  if (ok) return;
  printf("::vm-test::fail: fork-fault: %s errno=%d\n", message, errno);
  fflush(stdout);
  _exit(120);
}
static void no_children(void)
{
  int status;
  errno = 0;
  require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD,
    "failed or reaped clone left a waitable child");
}
static void check_mask(void)
{
  sigset_t mask;
  require(!pthread_sigmask(SIG_SETMASK, NULL, &mask) &&
    sigismember(&mask, SIGUSR1) == 1 && sigismember(&mask, SIGUSR2) == 0,
    "parent signal mask not restored");
}
int main(void)
{
  pid_t original = getpid();
  volatile int local = 21;
  int *heap = malloc(sizeof(*heap));
  require(heap != NULL, "heap");
  *heap = 51;
  sigset_t mask;
  sigemptyset(&mask); sigaddset(&mask, SIGUSR1);
  require(!pthread_sigmask(SIG_SETMASK, &mask, NULL), "block signal");
  require(!pthread_atfork(prepare, parent, child), "atfork");
  int failures = 0;
#ifdef __wasm__
  const int errors[] = {EAGAIN, ENOMEM};
  for (int i = 0; i < 2; i++) {
    errno = 0;
    pid_t pid = fork();
    if (!pid) _exit(119); // An injected failure must never enter the child.
    require(pid == -1 && errno == errors[i], "injected clone errno");
    failures++;
    require(getpid() == original && prepares == failures && parents == failures &&
      !children, "failed clone identity or atfork");
    require(local == 21 && global_value == 31 && tls_value == 41 && *heap == 51,
      "failed clone changed memory");
    check_mask();
    no_children();
  }
  puts("fork-fault: initialization and allocation errors, atfork, mask and no-child pass");
  errno = 0;
  pid_t timed = fork();
  if (!timed) _exit(119);
  require(timed == -1 && errno == EAGAIN, "publication timeout errno");
  failures++;
  require(getpid() == original && prepares == failures && parents == failures && !children,
    "timeout identity or atfork");
  require(local == 21 && global_value == 31 && tls_value == 41 && *heap == 51,
    "timeout changed memory");
  check_mask();
  no_children();
  puts("fork-fault: publication timeout, late child rejection and parent recovery pass");
#endif
  for (int i = 0; i < 8; i++) {
    pid_t pid = fork();
    require(pid >= 0, "fork after failures");
    if (!pid) {
      require(getpid() != original && getppid() == original && children == 1 &&
        prepares == failures + i + 1 && parents == failures + i,
        "recovery child identity or atfork");
      require(local == 21 && global_value == 31 && tls_value == 41 && *heap == 51,
        "recovery child snapshot");
      check_mask();
      local = 101; global_value = 102; tls_value = 103; *heap = 104;
      _exit(42);
    }
    int status;
    require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 42,
      "recovery child wait");
    require(prepares == failures + i + 1 && parents == failures + i + 1 && !children,
      "recovery parent atfork");
    require(local == 21 && global_value == 31 && tls_value == 41 && *heap == 51,
      "recovery parent isolation");
    check_mask();
    no_children();
  }
  free(heap);
  puts("fork-fault: eight recovery forks, identity, TLS, isolation and single reap pass");
  puts("::vm-test::pass");
  fflush(stdout);
#ifdef __wasm__
  for (;;) sched_yield(); // PID 1 must not exit before the runner closes the machine.
#endif
  return 0;
}
