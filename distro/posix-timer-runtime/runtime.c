#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "posix-timer-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void add_ns(struct timespec *ts, long ns) {
  ts->tv_nsec += ns;
  while (ts->tv_nsec >= 1000000000L) {
    ts->tv_nsec -= 1000000000L;
    ts->tv_sec += 1;
  }
}

static int ts_ge(const struct timespec *a, const struct timespec *b) {
  if (a->tv_sec != b->tv_sec) {
    return a->tv_sec > b->tv_sec;
  }
  return a->tv_nsec >= b->tv_nsec;
}

static void wait_timer_sig(const sigset_t *set, int expected_sig,
                           int expected_val) {
  siginfo_t si;
  struct timespec to = {.tv_sec = 2, .tv_nsec = 0};
  int sig;
  do {
    sig = sigtimedwait(set, &si, &to);
  } while (sig < 0 && errno == EINTR);
  require(sig == expected_sig, "sigtimedwait timer");
  require(si.si_signo == expected_sig && si.si_code == SI_TIMER &&
              si.si_value.sival_int == expected_val,
          "timer siginfo fields");
}

int main(void) {
  struct timespec res;
  require(clock_getres(CLOCK_MONOTONIC, &res) == 0, "clock_getres MONOTONIC");
  require(res.tv_sec == 0 && res.tv_nsec > 0, "valid monotonic res");

  sigset_t set;
  require(sigemptyset(&set) == 0, "sigemptyset");
  require(sigaddset(&set, SIGRTMIN) == 0, "sigaddset(SIGRTMIN)");
  require(sigaddset(&set, SIGRTMIN + 1) == 0, "sigaddset(SIGRTMIN+1)");
  require(sigprocmask(SIG_BLOCK, &set, NULL) == 0, "sigprocmask(SIG_BLOCK)");

  struct sigevent sev;
  memset(&sev, 0, sizeof(sev));
  sev.sigev_notify = SIGEV_SIGNAL;
  sev.sigev_signo = SIGRTMIN;
  sev.sigev_value.sival_int = 0x2468ACE0;

  timer_t tid_mono;
  require(timer_create(CLOCK_MONOTONIC, &sev, &tid_mono) == 0,
          "timer_create(CLOCK_MONOTONIC)");

  struct itimerspec its;
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = 5000000L;
  its.it_interval.tv_nsec = 5000000L;
  require(timer_settime(tid_mono, 0, &its, NULL) == 0,
          "timer_settime periodic");

  struct itimerspec cur;
  require(timer_gettime(tid_mono, &cur) == 0, "timer_gettime periodic");
  require(cur.it_interval.tv_nsec == 5000000L, "timer interval preserved");

  wait_timer_sig(&set, SIGRTMIN, 0x2468ACE0);
  int overrun = timer_getoverrun(tid_mono);
  require(overrun >= 0, "timer_getoverrun");

  memset(&its, 0, sizeof(its));
  require(timer_settime(tid_mono, 0, &its, NULL) == 0, "timer disarm");
  require(timer_delete(tid_mono) == 0, "timer_delete(tid_mono)");

  sigset_t m_mono;
  require(sigemptyset(&m_mono) == 0, "sigemptyset drain");
  require(sigaddset(&m_mono, SIGRTMIN) == 0, "sigaddset drain");
  struct timespec zero_to = {.tv_sec = 0, .tv_nsec = 0};
  siginfo_t dummy;
  while (sigtimedwait(&m_mono, &dummy, &zero_to) > 0) {
  }

  memset(&sev, 0, sizeof(sev));
  sev.sigev_notify = SIGEV_SIGNAL;
  sev.sigev_signo = SIGRTMIN + 1;
  sev.sigev_value.sival_int = 0x13579BDF;

  timer_t tid_boot;
  require(timer_create(CLOCK_BOOTTIME, &sev, &tid_boot) == 0,
          "timer_create(CLOCK_BOOTTIME)");

  struct timespec now_boot;
  require(clock_gettime(CLOCK_BOOTTIME, &now_boot) == 0,
          "clock_gettime(CLOCK_BOOTTIME)");
  add_ns(&now_boot, 5000000L);
  memset(&its, 0, sizeof(its));
  its.it_value = now_boot;
  require(timer_settime(tid_boot, TIMER_ABSTIME, &its, NULL) == 0,
          "timer_settime TIMER_ABSTIME");

  wait_timer_sig(&set, SIGRTMIN + 1, 0x13579BDF);
  require(timer_delete(tid_boot) == 0, "timer_delete(tid_boot)");

  struct timespec target, after;
  require(clock_gettime(CLOCK_MONOTONIC, &target) == 0,
          "clock_gettime(CLOCK_MONOTONIC)");
  add_ns(&target, 10000000L);
  int rc;
  do {
    rc = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &target, NULL);
  } while (rc == EINTR);
  require(rc == 0, "clock_nanosleep(TIMER_ABSTIME)");
  require(clock_gettime(CLOCK_MONOTONIC, &after) == 0,
          "clock_gettime after sleep");
  require(ts_ge(&after, &target), "clock_nanosleep reached target");

  printf("posix-timer-runtime: ok res_ns=%ld overrun=%d\n", res.tv_nsec,
         overrun);
  return 0;
}
