#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysinfo.h>
#include <sys/times.h>
#include <sys/utsname.h>
#include <time.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static long long tv_to_us(const struct timeval *tv) {
  return (long long)tv->tv_sec * 1000000LL + (long long)tv->tv_usec;
}

static int burn_cpu_and_heap(void) {
  volatile unsigned long acc = 0;
  char *buf = malloc(65536);
  if (!buf)
    return fail_errno("malloc");
  memset(buf, 0x5a, 65536);
  for (unsigned long i = 0; i < 2000000UL; ++i)
    acc += i ^ (i >> 3) ^ (unsigned char)buf[i & 65535U];
  free(buf);
  return acc == 0 ? 0 : 0;
}

static int test_rusage_and_times(void) {
  struct rusage ru1, ru2;
  struct tms tms1, tms2;
  clock_t t1, t2;
  long long u1, s1, u2, s2;
  int iter = 0;

  if (getrusage(RUSAGE_SELF, &ru1) != 0)
    return fail_errno("getrusage(before)");
  t1 = times(&tms1);
  if (t1 == (clock_t)-1)
    return fail_errno("times(before)");

  u1 = tv_to_us(&ru1.ru_utime);
  s1 = tv_to_us(&ru1.ru_stime);
  if (u1 < 0 || s1 < 0) {
    fprintf(stderr, "FAIL: negative initial rusage u=%lld s=%lld\n", u1, s1);
    return 1;
  }

  do {
    if (burn_cpu_and_heap() != 0)
      return 1;
    if (getrusage(RUSAGE_SELF, &ru2) != 0)
      return fail_errno("getrusage(after)");
    t2 = times(&tms2);
    if (t2 == (clock_t)-1)
      return fail_errno("times(after)");
    u2 = tv_to_us(&ru2.ru_utime);
    s2 = tv_to_us(&ru2.ru_stime);
    iter++;
  } while (u2 == 0 && s2 == 0 && tms2.tms_utime == tms1.tms_utime &&
           tms2.tms_stime == tms1.tms_stime && iter < 16);

  if (u2 < u1 || s2 < s1) {
    fprintf(stderr,
            "FAIL: rusage went backwards u:%lld->%lld s:%lld->%lld\n",
            u1, u2, s1, s2);
    return 1;
  }

  if (u2 <= 0 && s2 <= 0 && tms2.tms_utime <= tms1.tms_utime &&
      tms2.tms_stime <= tms1.tms_stime) {
    fprintf(stderr, "FAIL: no CPU time recorded after work\n");
    return 1;
  }

  if (tms2.tms_utime < tms1.tms_utime || tms2.tms_stime < tms1.tms_stime ||
      (long)(t2 - t1) < 0) {
    fprintf(stderr,
            "FAIL: times() non-monotonic u:%ld->%ld s:%ld->%ld clk:%ld->%ld\n",
            (long)tms1.tms_utime, (long)tms2.tms_utime, (long)tms1.tms_stime,
            (long)tms2.tms_stime, (long)t1, (long)t2);
    return 1;
  }

  printf("rusage_times: ok (u=%lldus s=%lldus ticks=%ld)\n", u2, s2,
         (long)(t2 - t1));
  return 0;
}

static int test_sysinfo_uname(void) {
  struct sysinfo si;
  struct utsname uts;

  if (sysinfo(&si) != 0)
    return fail_errno("sysinfo");
  if (si.uptime < 0 || si.totalram == 0 || si.mem_unit == 0 || si.procs < 1) {
    fprintf(stderr,
            "FAIL: sysinfo invalid uptime=%ld totalram=%lu unit=%u procs=%u\n",
            (long)si.uptime, (unsigned long)si.totalram,
            (unsigned)si.mem_unit, (unsigned)si.procs);
    return 1;
  }

  if (uname(&uts) != 0)
    return fail_errno("uname");
  if (strcmp(uts.sysname, "Linux") != 0 || uts.release[0] == '\0' ||
      uts.machine[0] == '\0') {
    fprintf(stderr, "FAIL: uname invalid sys='%s' rel='%s' mach='%s'\n",
            uts.sysname, uts.release, uts.machine);
    return 1;
  }

  printf("sysinfo_uname: ok (sys=%s rel=%s mach=%s procs=%u)\n",
         uts.sysname, uts.release, uts.machine, (unsigned)si.procs);
  return 0;
}

static int test_clock_and_getcpu(void) {
  struct timespec res, t1, t2;

  if (clock_getres(CLOCK_MONOTONIC, &res) != 0)
    return fail_errno("clock_getres(CLOCK_MONOTONIC)");
  if (res.tv_sec < 0 || res.tv_nsec < 0 || (res.tv_sec == 0 && res.tv_nsec == 0)) {
    fprintf(stderr, "FAIL: invalid clock_getres %lld.%09ld\n",
            (long long)res.tv_sec, res.tv_nsec);
    return 1;
  }

  if (clock_gettime(CLOCK_MONOTONIC, &t1) != 0)
    return fail_errno("clock_gettime(1)");
  if (clock_gettime(CLOCK_MONOTONIC, &t2) != 0)
    return fail_errno("clock_gettime(2)");

  if (t2.tv_sec < t1.tv_sec ||
      (t2.tv_sec == t1.tv_sec && t2.tv_nsec < t1.tv_nsec)) {
    fprintf(stderr, "FAIL: CLOCK_MONOTONIC went backwards\n");
    return 1;
  }

  int cpu = sched_getcpu();
  if (cpu < 0)
    return fail_errno("sched_getcpu");

  printf("clock_getcpu: ok (res=%lld.%09lds cpu=%d)\n",
         (long long)res.tv_sec, res.tv_nsec, cpu);
  return 0;
}

int main(void) {
  if (test_rusage_and_times() != 0)
    return 1;
  if (test_sysinfo_uname() != 0)
    return 1;
  if (test_clock_and_getcpu() != 0)
    return 1;
  printf("getrusage-times-sysinfo-runtime: PASS\n");
  return 0;
}
