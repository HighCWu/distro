#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

int main(void) {
  int rtsig = SIGRTMIN + 1;
  pid_t me = getpid();
  sigset_t mask, orig, pend;
  static const int vals[3] = { 101, 202, 303 };
  siginfo_t si;
  struct timespec zero_ts;
  int got;

  sigemptyset(&mask);
  sigaddset(&mask, rtsig);
  if (sigprocmask(SIG_BLOCK, &mask, &orig) != 0)
    return fail_errno("sigprocmask(SIG_BLOCK)");

  for (int i = 0; i < 3; ++i) {
    union sigval sv;
    sv.sival_int = vals[i];
    if (sigqueue(me, rtsig, sv) != 0)
      return fail_errno("sigqueue");
  }

  sigemptyset(&pend);
  if (sigpending(&pend) != 0)
    return fail_errno("sigpending(before)");
  if (!sigismember(&pend, rtsig)) {
    fprintf(stderr, "FAIL: rtsig=%d not pending after sigqueue\n", rtsig);
    return 1;
  }

  for (int i = 0; i < 3; ++i) {
    memset(&si, 0, sizeof(si));
    got = sigwaitinfo(&mask, &si);
    if (got != rtsig || si.si_code != SI_QUEUE || si.si_pid != me ||
        si.si_value.sival_int != vals[i]) {
      fprintf(stderr,
              "FAIL: sigwaitinfo[%d] got=%d code=%d pid=%ld val=%d (exp %d)\n",
              i, got, si.si_code, (long)si.si_pid, si.si_value.sival_int,
              vals[i]);
      return 1;
    }
  }

  sigemptyset(&pend);
  if (sigpending(&pend) != 0)
    return fail_errno("sigpending(after)");
  if (sigismember(&pend, rtsig)) {
    fprintf(stderr, "FAIL: rtsig=%d still pending after draining 3\n", rtsig);
    return 1;
  }

  zero_ts.tv_sec = 0;
  zero_ts.tv_nsec = 0;
  errno = 0;
  got = sigtimedwait(&mask, &si, &zero_ts);
  if (got != -1 || errno != EAGAIN) {
    fprintf(stderr, "FAIL: sigtimedwait(empty) got=%d errno=%d, expected EAGAIN\n",
            got, errno);
    return 1;
  }

  if (sigprocmask(SIG_SETMASK, &orig, NULL) != 0)
    return fail_errno("sigprocmask(restore)");

  printf("sigwaitinfo-sigqueue-rt-runtime: PASS\n");
  return 0;
}
