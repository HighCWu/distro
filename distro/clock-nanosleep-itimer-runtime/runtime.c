#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static volatile sig_atomic_t g_alrm_count = 0;

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static void on_sigalrm(int sig) {
  (void)sig;
  g_alrm_count++;
}

static int64_t ts_diff_ns(const struct timespec *a, const struct timespec *b) {
  return (int64_t)(b->tv_sec - a->tv_sec) * 1000000000LL +
         (int64_t)(b->tv_nsec - a->tv_nsec);
}

static int test_clock_and_nanosleep(void) {
  struct timespec res, t1, t2, target, after, rel, rem, bad;
  int64_t elapsed;
  int rc;

  if (clock_getres(CLOCK_MONOTONIC, &res) != 0)
    return fail_errno("clock_getres(CLOCK_MONOTONIC)");
  if (res.tv_sec < 0 || res.tv_nsec < 0 ||
      (res.tv_sec == 0 && res.tv_nsec == 0)) {
    fprintf(stderr, "FAIL: invalid CLOCK_MONOTONIC res\n");
    return 1;
  }

  if (clock_getres(CLOCK_REALTIME, &res) != 0)
    return fail_errno("clock_getres(CLOCK_REALTIME)");

  if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0)
    return fail_errno("clock_gettime(t1)");

  rel.tv_sec = 0;
  rel.tv_nsec = 5000000L;
  while ((rc = clock_nanosleep(CLOCK_MONOTONIC, 0, &rel, &rem)) == EINTR)
    rel = rem;
  if (rc != 0) {
    errno = rc;
    return fail_errno("clock_nanosleep(relative)");
  }

  if (clock_gettime(CLOCK_MONOTONIC, &t2) != 0)
    return fail_errno("clock_gettime(t2)");
  elapsed = ts_diff_ns(&t1, &t2);
  if (elapsed < 1000000LL) {
    fprintf(stderr, "FAIL: relative sleep elapsed=%lldns\n",
            (long long)elapsed);
    return 1;
  }

  target = t2;
  target.tv_nsec += 5000000L;
  if (target.tv_nsec >= 1000000000L) {
    target.tv_sec += 1;
    target.tv_nsec -= 1000000000L;
  }
  while ((rc = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &target,
                               NULL)) == EINTR)
    ;
  if (rc != 0) {
    errno = rc;
    return fail_errno("clock_nanosleep(TIMER_ABSTIME)");
  }

  if (clock_gettime(CLOCK_MONOTONIC, &after) != 0)
    return fail_errno("clock_gettime(after)");
  if (ts_diff_ns(&target, &after) < 0) {
    fprintf(stderr, "FAIL: TIMER_ABSTIME woke up early\n");
    return 1;
  }

  rel.tv_sec = 0;
  rel.tv_nsec = 2000000L;
  if (nanosleep(&rel, &rem) != 0)
    return fail_errno("nanosleep(2ms)");

  bad.tv_sec = 0;
  bad.tv_nsec = -1;
  errno = 0;
  if (nanosleep(&bad, NULL) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: nanosleep(-1ns) expected EINVAL, errno=%d\n", errno);
    return 1;
  }

  bad.tv_sec = 0;
  bad.tv_nsec = 1000000000L;
  rc = clock_nanosleep(CLOCK_MONOTONIC, 0, &bad, NULL);
  if (rc != EINVAL) {
    fprintf(stderr, "FAIL: clock_nanosleep(1e9ns) expected EINVAL, rc=%d\n",
            rc);
    return 1;
  }

  printf("clock_nanosleep: ok (elapsed=%lldns)\n", (long long)elapsed);
  return 0;
}

static int test_itimer_real(void) {
  struct sigaction sa, old_sa;
  struct itimerval itv, cur, zero_itv;
  struct timespec req, rem;

  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_sigalrm;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  if (sigaction(SIGALRM, &sa, &old_sa) != 0)
    return fail_errno("sigaction(SIGALRM)");

  g_alrm_count = 0;
  memset(&itv, 0, sizeof(itv));
  itv.it_value.tv_usec = 10000;
  if (setitimer(ITIMER_REAL, &itv, NULL) != 0)
    return fail_errno("setitimer(ITIMER_REAL)");

  memset(&cur, 0, sizeof(cur));
  if (getitimer(ITIMER_REAL, &cur) != 0)
    return fail_errno("getitimer(ITIMER_REAL)");

  req.tv_sec = 0;
  req.tv_nsec = 50000000L;
  for (int i = 0; i < 10 && g_alrm_count == 0; ++i) {
    if (nanosleep(&req, &rem) == 0)
      break;
    if (errno != EINTR)
      return fail_errno("nanosleep(itimer wait)");
    req = rem;
  }

  memset(&zero_itv, 0, sizeof(zero_itv));
  if (setitimer(ITIMER_REAL, &zero_itv, NULL) != 0)
    return fail_errno("setitimer(disarm)");
  if (sigaction(SIGALRM, &old_sa, NULL) != 0)
    return fail_errno("sigaction(restore)");

  if (g_alrm_count != 1) {
    fprintf(stderr, "FAIL: expected 1 SIGALRM, got %d\n", (int)g_alrm_count);
    return 1;
  }

  printf("itimer_real: ok (alarms=%d)\n", (int)g_alrm_count);
  return 0;
}

int main(void) {
  if (test_clock_and_nanosleep() != 0)
    return 1;
  if (test_itimer_real() != 0)
    return 1;
  printf("clock-nanosleep-itimer-runtime: PASS\n");
  return 0;
}
