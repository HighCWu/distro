// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t hits;
static _Thread_local volatile int tls_cookie = 0x1234;
static int prepares, parents, children, prepare_error;
static void handler(int signal) { if (signal == SIGUSR1) hits++; }
static void prepare(void)
{
  sigset_t pending;
  if (sigpending(&pending) || sigismember(&pending, SIGUSR1)) prepare_error = 1;
  prepares++;
#if !defined(__wasm__) && !defined(FORK_SIGNAL_NEGATIVE_CONTROL) && !defined(FORK_SIGNAL_AFTER_CLONE)
  // Native fixture baseline only, not the Wasm saved-continuation timing.
  if (kill(getpid(), SIGUSR1)) prepare_error = 1;
#endif
}
static void parent(void)
{
  parents++;
#if !defined(__wasm__) && !defined(FORK_SIGNAL_NEGATIVE_CONTROL) && defined(FORK_SIGNAL_AFTER_CLONE)
  // Native baseline after clone only; this is not the Wasm pre-rewind point.
  if (kill(getpid(), SIGUSR1)) prepare_error = 1;
#endif
}
static void child(void) { children++; }
static void require(int ok, const char *message)
{
  if (ok) return;
  printf("::vm-test::fail: fork-signal: %s errno=%d\n", message, errno);
  fflush(stdout);
#ifdef __wasm__
  for (;;) sched_yield();
#else
  _exit(120);
#endif
}
static void check_mask(void)
{
  sigset_t mask;
  require(!pthread_sigmask(SIG_SETMASK, NULL, &mask) &&
    sigismember(&mask, SIGUSR1) == 1 && sigismember(&mask, SIGUSR2) == 0,
    "restored mask");
}
static int pending_usr1(void)
{
  sigset_t pending;
  require(!sigpending(&pending), "read pending");
  return sigismember(&pending, SIGUSR1);
}
int main(void)
{
  pid_t original = getpid();
  sigset_t mask;
  sigemptyset(&mask); sigaddset(&mask, SIGUSR1);
  struct sigaction action = {.sa_handler = handler};
  sigemptyset(&action.sa_mask);
  require(!sigaction(SIGUSR1, &action, NULL), "install handler");
  require(!pthread_sigmask(SIG_SETMASK, &mask, NULL), "block signal");
  require(!pthread_atfork(prepare, parent, child), "register atfork");
  for (int iteration = 0; iteration < 2; iteration++) {
    require(hits == iteration && !pending_usr1(), "fresh signal state");
    volatile int stack_cookie = 0x5678 + iteration;
    tls_cookie = 0x1234 + iteration;
    pid_t pid = fork();
    require(pid >= 0, "fork");
    require(stack_cookie == 0x5678 + iteration && tls_cookie == 0x1234 + iteration,
      "restored stack and TLS");
    require(!prepare_error && prepares == iteration + 1 && hits == iteration,
      "handler ran during saved fork or atfork repeated");
    check_mask();
    if (!pid) {
      require(getpid() != original && getppid() == original && children == 1 &&
        parents == iteration, "child identity and atfork");
      require(!pending_usr1(), "child inherited parent pending signal");
      require(!kill(getpid(), SIGUSR1) && pending_usr1() == 1 && hits == iteration,
        "child inherited handler and blocking");
      require(!pthread_sigmask(SIG_UNBLOCK, &mask, NULL), "child unblock");
      require(hits == iteration + 1 && !pending_usr1(), "child single delivery");
      _exit(42);
    }
    require(getpid() == original && parents == iteration + 1 && !children,
      "parent identity and atfork");
    require(pending_usr1() == 1, "parent pending missing");
    require(!pthread_sigmask(SIG_UNBLOCK, &mask, NULL), "parent unblock");
    require(hits == iteration + 1 && !pending_usr1(), "parent single delivery");
    require(!pthread_sigmask(SIG_BLOCK, &mask, NULL), "restore block for next fork");
    int status;
    require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 42,
      "child wait");
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
  }
#ifdef FORK_SIGNAL_AFTER_CLONE
  puts("fork-signal: post-clone pre-rewind parent pending and child isolation pass");
  puts("fork-signal: two post-clone forks, stack, TLS and single delivery pass");
#else
  puts("fork-signal: saved-fork parent pending and child isolation pass");
  puts("fork-signal: two forks, inherited mask, handler and single delivery pass");
#endif
  puts("::vm-test::pass");
  fflush(stdout);
#ifdef __wasm__
  for (;;) sched_yield();
#endif
  return 0;
}
