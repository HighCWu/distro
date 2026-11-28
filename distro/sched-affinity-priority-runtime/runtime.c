#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int test_affinity(void) {
  cpu_set_t orig_mask, pin_mask, cur_mask, empty_mask;
  int count, first_cpu = -1;

  CPU_ZERO(&orig_mask);
  if (sched_getaffinity(0, sizeof(orig_mask), &orig_mask) != 0)
    return fail_errno("sched_getaffinity(orig)");

  count = CPU_COUNT(&orig_mask);
  if (count < 1) {
    fprintf(stderr, "FAIL: CPU_COUNT=%d, expected >= 1\n", count);
    return 1;
  }

  for (int i = 0; i < CPU_SETSIZE; ++i) {
    if (CPU_ISSET(i, &orig_mask)) {
      first_cpu = i;
      break;
    }
  }
  if (first_cpu < 0) {
    fprintf(stderr, "FAIL: no CPU set in orig_mask\n");
    return 1;
  }

  CPU_ZERO(&pin_mask);
  CPU_SET(first_cpu, &pin_mask);
  if (sched_setaffinity(0, sizeof(pin_mask), &pin_mask) != 0)
    return fail_errno("sched_setaffinity(pin)");

  CPU_ZERO(&cur_mask);
  if (sched_getaffinity(0, sizeof(cur_mask), &cur_mask) != 0)
    return fail_errno("sched_getaffinity(pinned)");
  if (CPU_COUNT(&cur_mask) != 1 || !CPU_ISSET(first_cpu, &cur_mask)) {
    fprintf(stderr, "FAIL: pinned affinity count=%d cpu=%d\n",
            CPU_COUNT(&cur_mask), first_cpu);
    return 1;
  }

  if (sched_setaffinity(0, sizeof(orig_mask), &orig_mask) != 0)
    return fail_errno("sched_setaffinity(restore)");

  CPU_ZERO(&cur_mask);
  if (sched_getaffinity(0, sizeof(cur_mask), &cur_mask) != 0)
    return fail_errno("sched_getaffinity(restored)");
  if (!CPU_EQUAL(&orig_mask, &cur_mask)) {
    fprintf(stderr, "FAIL: restored affinity does not match original\n");
    return 1;
  }

  CPU_ZERO(&empty_mask);
  errno = 0;
  if (sched_setaffinity(0, sizeof(empty_mask), &empty_mask) != -1 ||
      errno != EINVAL) {
    fprintf(stderr, "FAIL: empty sched_setaffinity errno=%d\n", errno);
    return 1;
  }

  printf("affinity: ok (cpus=%d first=%d)\n", count, first_cpu);
  return 0;
}

static int test_scheduler_and_priority(void) {
  int pol, min_other, max_other, min_fifo, max_fifo;
  int orig_prio, target_prio, got_prio;

  pol = (int)syscall(SYS_sched_getscheduler, 0);
  if (pol < 0)
    return fail_errno("syscall(SYS_sched_getscheduler, 0)");

  min_other = sched_get_priority_min(SCHED_OTHER);
  max_other = sched_get_priority_max(SCHED_OTHER);
  if (min_other != 0 || max_other != 0) {
    fprintf(stderr, "FAIL: SCHED_OTHER prio range %d..%d\n",
            min_other, max_other);
    return 1;
  }

  min_fifo = sched_get_priority_min(SCHED_FIFO);
  max_fifo = sched_get_priority_max(SCHED_FIFO);
  if (min_fifo < 1 || max_fifo < min_fifo) {
    fprintf(stderr, "FAIL: SCHED_FIFO prio range %d..%d\n",
            min_fifo, max_fifo);
    return 1;
  }

  errno = 0;
  if (sched_get_priority_min(-1) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: sched_get_priority_min(-1) errno=%d\n", errno);
    return 1;
  }

  if (sched_yield() != 0)
    return fail_errno("sched_yield");

  errno = 0;
  orig_prio = getpriority(PRIO_PROCESS, 0);
  if (orig_prio == -1 && errno != 0)
    return fail_errno("getpriority(orig)");

  target_prio = (orig_prio < 10) ? orig_prio + 5 : 15;
  if (setpriority(PRIO_PROCESS, 0, target_prio) != 0)
    return fail_errno("setpriority(target)");

  errno = 0;
  got_prio = getpriority(PRIO_PROCESS, 0);
  if (got_prio == -1 && errno != 0)
    return fail_errno("getpriority(target)");
  if (got_prio != target_prio) {
    fprintf(stderr, "FAIL: getpriority=%d, expected %d\n",
            got_prio, target_prio);
    return 1;
  }

  if (setpriority(PRIO_PROCESS, 0, orig_prio) != 0 &&
      errno != EACCES && errno != EPERM) {
    return fail_errno("setpriority(restore)");
  }

  printf("sched_priority: ok (pol=%d fifo=%d..%d prio=%d->%d)\n",
         pol, min_fifo, max_fifo, orig_prio, got_prio);
  return 0;
}

int main(void) {
  if (test_affinity() != 0)
    return 1;
  if (test_scheduler_and_priority() != 0)
    return 1;
  printf("sched-affinity-priority-runtime: PASS\n");
  return 0;
}
