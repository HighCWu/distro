#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t g_got_sig = 0;
static volatile sig_atomic_t g_got_code = 0;
static volatile sig_atomic_t g_got_val = 0;
static volatile uintptr_t g_handler_sp = 0;

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static void on_sigusr1(int sig, siginfo_t *si, void *uctx) {
  volatile int local_var = 1;
  (void)uctx;
  g_got_sig = sig;
  g_got_code = si ? si->si_code : 0;
  g_got_val = si ? si->si_value.sival_int : 0;
  g_handler_sp = (uintptr_t)(const volatile void *)&local_var;
}

static int test_sigaltstack_sigqueue(void) {
  size_t ss_size = (size_t)SIGSTKSZ * 2U;
  void *ss_mem = malloc(ss_size);
  stack_t ss, old_ss;
  struct sigaction sa, old_sa;
  union sigval sv;
  uintptr_t base, sp;

  if (!ss_mem)
    return fail_errno("malloc(sigaltstack)");

  memset(&ss, 0, sizeof(ss));
  ss.ss_sp = ss_mem;
  ss.ss_size = ss_size;
  ss.ss_flags = 0;
  if (sigaltstack(&ss, &old_ss) != 0)
    return fail_errno("sigaltstack(install)");

  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = on_sigusr1;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
  if (sigaction(SIGUSR1, &sa, &old_sa) != 0)
    return fail_errno("sigaction(SIGUSR1)");

  g_got_sig = 0;
  g_got_code = 0;
  g_got_val = 0;
  g_handler_sp = 0;

  sv.sival_int = 42;
  if (sigqueue(getpid(), SIGUSR1, sv) != 0)
    return fail_errno("sigqueue(SIGUSR1)");

  base = (uintptr_t)ss_mem;
  sp = g_handler_sp;
  if (g_got_sig != SIGUSR1 || g_got_code != SI_QUEUE || g_got_val != 42) {
    fprintf(stderr, "FAIL: sigqueue handler sig=%d code=%d val=%d\n",
            (int)g_got_sig, (int)g_got_code, (int)g_got_val);
    return 1;
  }
  if (sp < base || sp >= base + ss_size) {
    fprintf(stderr, "FAIL: handler sp=0x%zx not in altstack [0x%zx, 0x%zx)\n",
            (size_t)sp, (size_t)base, (size_t)(base + ss_size));
    return 1;
  }

  if (sigaction(SIGUSR1, &old_sa, NULL) != 0)
    return fail_errno("sigaction(restore)");

  memset(&ss, 0, sizeof(ss));
  ss.ss_flags = SS_DISABLE;
  if (sigaltstack(&ss, NULL) != 0)
    return fail_errno("sigaltstack(SS_DISABLE)");
  free(ss_mem);

  printf("sigaltstack_sigqueue: ok (val=%d sp_offset=%zu)\n",
         (int)g_got_val, (size_t)(sp - base));
  return 0;
}

static int test_sigpending_sigtimedwait(void) {
  sigset_t mask, orig, pend;
  siginfo_t info;
  struct timespec ts;
  int sig;

  sigemptyset(&mask);
  sigaddset(&mask, SIGUSR2);
  if (sigprocmask(SIG_BLOCK, &mask, &orig) != 0)
    return fail_errno("sigprocmask(SIG_BLOCK, SIGUSR2)");

  if (raise(SIGUSR2) != 0)
    return fail_errno("raise(SIGUSR2)");

  sigemptyset(&pend);
  if (sigpending(&pend) != 0)
    return fail_errno("sigpending(before)");
  if (!sigismember(&pend, SIGUSR2)) {
    fprintf(stderr, "FAIL: SIGUSR2 not in sigpending set\n");
    return 1;
  }

  ts.tv_sec = 0;
  ts.tv_nsec = 50000000L;
  memset(&info, 0, sizeof(info));
  sig = sigtimedwait(&mask, &info, &ts);
  if (sig != SIGUSR2 || info.si_signo != SIGUSR2) {
    fprintf(stderr, "FAIL: sigtimedwait got %d si_signo=%d (errno=%d)\n",
            sig, info.si_signo, errno);
    return 1;
  }

  sigemptyset(&pend);
  if (sigpending(&pend) != 0)
    return fail_errno("sigpending(after)");
  if (sigismember(&pend, SIGUSR2)) {
    fprintf(stderr, "FAIL: SIGUSR2 still pending after sigtimedwait\n");
    return 1;
  }

  if (sigprocmask(SIG_SETMASK, &orig, NULL) != 0)
    return fail_errno("sigprocmask(restore)");

  printf("sigpending_sigtimedwait: ok (sig=%d)\n", sig);
  return 0;
}

int main(void) {
  if (test_sigaltstack_sigqueue() != 0)
    return 1;
  if (test_sigpending_sigtimedwait() != 0)
    return 1;
  printf("signal-sigaltstack-sigaction-runtime: PASS\n");
  return 0;
}
