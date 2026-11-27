#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifdef __has_include
#if __has_include(<linux/membarrier.h>)
#include <linux/membarrier.h>
#endif
#endif

#ifndef MEMBARRIER_CMD_QUERY
#define MEMBARRIER_CMD_QUERY 0
#define MEMBARRIER_CMD_GLOBAL (1 << 0)
#define MEMBARRIER_CMD_GLOBAL_EXPEDITED (1 << 1)
#define MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED (1 << 2)
#define MEMBARRIER_CMD_PRIVATE_EXPEDITED (1 << 3)
#define MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED (1 << 4)
#endif

#ifndef SYS_membarrier
#define SYS_membarrier 283
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "membarrier-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static long do_membarrier(int cmd, unsigned int flags, int cpu_id) {
  return syscall(SYS_membarrier, cmd, flags, cpu_id);
}

struct sync_state {
  atomic_int seq_a;
  atomic_int seq_b;
  atomic_int stop;
};

static void *worker_fn(void *arg) {
  struct sync_state *st = (struct sync_state *)arg;
  atomic_store_explicit(&st->seq_a, 1, memory_order_release);
  while (atomic_load_explicit(&st->seq_b, memory_order_relaxed) != 1) {
    sched_yield();
  }
  atomic_store_explicit(&st->seq_a, 2, memory_order_release);
  while (atomic_load_explicit(&st->stop, memory_order_acquire) == 0) {
    sched_yield();
  }
  return NULL;
}

int main(void) {
  long mask = do_membarrier(MEMBARRIER_CMD_QUERY, 0, 0);
  require(mask > 0, "MEMBARRIER_CMD_QUERY");

  long required = MEMBARRIER_CMD_GLOBAL | MEMBARRIER_CMD_GLOBAL_EXPEDITED |
                  MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED |
                  MEMBARRIER_CMD_PRIVATE_EXPEDITED |
                  MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED;
  require((mask & required) == required, "membarrier supported commands mask");

  require(do_membarrier(MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED, 0, 0) == 0,
          "MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED");
  require(do_membarrier(MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED, 0, 0) == 0,
          "MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED");

  struct sync_state st;
  atomic_init(&st.seq_a, 0);
  atomic_init(&st.seq_b, 0);
  atomic_init(&st.stop, 0);

  pthread_t tid;
  require(pthread_create(&tid, NULL, worker_fn, &st) == 0, "pthread_create");

  while (atomic_load_explicit(&st.seq_a, memory_order_acquire) != 1) {
    sched_yield();
  }
  require(do_membarrier(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0, 0) == 0,
          "MEMBARRIER_CMD_PRIVATE_EXPEDITED");
  atomic_store_explicit(&st.seq_b, 1, memory_order_relaxed);
  require(do_membarrier(MEMBARRIER_CMD_GLOBAL_EXPEDITED, 0, 0) == 0,
          "MEMBARRIER_CMD_GLOBAL_EXPEDITED");

  while (atomic_load_explicit(&st.seq_a, memory_order_acquire) != 2) {
    sched_yield();
  }
  require(do_membarrier(MEMBARRIER_CMD_GLOBAL, 0, 0) == 0,
          "MEMBARRIER_CMD_GLOBAL");
  atomic_store_explicit(&st.stop, 1, memory_order_release);
  require(pthread_join(tid, NULL) == 0, "pthread_join");

  require(do_membarrier(MEMBARRIER_CMD_QUERY, 1, 0) == -1 && errno == EINVAL,
          "membarrier nonzero flags EINVAL");
  require(do_membarrier(0x40000000, 0, 0) == -1 && errno == EINVAL,
          "membarrier invalid cmd EINVAL");

  printf("membarrier-runtime: ok mask=0x%lx\n", mask);
  return 0;
}
