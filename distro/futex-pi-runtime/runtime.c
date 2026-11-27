#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <linux/futex.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_futex
#define SYS_futex 98
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "futex-pi-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static long sys_futex(volatile uint32_t *uaddr, int op, uint32_t val,
                      const struct timespec *timeout, volatile uint32_t *uaddr2,
                      uint32_t val3) {
  return syscall(SYS_futex, uaddr, op, val, timeout, uaddr2, val3);
}

struct pi_ctx {
  volatile uint32_t lock;
  atomic_int trylock_done;
  atomic_int worker_acquired;
};

static void *pi_worker(void *arg) {
  struct pi_ctx *ctx = (struct pi_ctx *)arg;
  long rc = sys_futex(&ctx->lock, FUTEX_TRYLOCK_PI | FUTEX_PRIVATE_FLAG, 0,
                      NULL, NULL, 0);
  require(rc == -1 && (errno == EAGAIN || errno == EWOULDBLOCK),
          "FUTEX_TRYLOCK_PI contended");
  atomic_store_explicit(&ctx->trylock_done, 1, memory_order_release);

  rc = sys_futex(&ctx->lock, FUTEX_LOCK_PI | FUTEX_PRIVATE_FLAG, 0, NULL, NULL,
                 0);
  require(rc == 0, "worker FUTEX_LOCK_PI");
  atomic_store_explicit(&ctx->worker_acquired, 1, memory_order_release);

  rc = sys_futex(&ctx->lock, FUTEX_UNLOCK_PI | FUTEX_PRIVATE_FLAG, 0, NULL,
                 NULL, 0);
  require(rc == 0, "worker FUTEX_UNLOCK_PI");
  return NULL;
}

struct bitset_ctx {
  volatile uint32_t word;
  atomic_int ready;
};

static void *bitset_worker(void *arg) {
  struct bitset_ctx *ctx = (struct bitset_ctx *)arg;
  atomic_store_explicit(&ctx->ready, 1, memory_order_release);
  long rc = sys_futex(&ctx->word, FUTEX_WAIT_BITSET | FUTEX_PRIVATE_FLAG, 0,
                      NULL, NULL, 0x04U);
  require(rc == 0 || (rc == -1 && errno == EAGAIN), "FUTEX_WAIT_BITSET");
  return NULL;
}

struct requeue_ctx {
  volatile uint32_t src;
  volatile uint32_t dst;
  atomic_int ready;
};

static void *requeue_worker(void *arg) {
  struct requeue_ctx *ctx = (struct requeue_ctx *)arg;
  atomic_store_explicit(&ctx->ready, 1, memory_order_release);
  long rc = sys_futex(&ctx->src, FUTEX_WAIT | FUTEX_PRIVATE_FLAG, 0, NULL, NULL,
                      0);
  require(rc == 0 || (rc == -1 && errno == EAGAIN), "requeue FUTEX_WAIT");
  return NULL;
}

int main(void) {
  struct pi_ctx pctx;
  pctx.lock = 0;
  atomic_init(&pctx.trylock_done, 0);
  atomic_init(&pctx.worker_acquired, 0);

  require(sys_futex(&pctx.lock, FUTEX_LOCK_PI | FUTEX_PRIVATE_FLAG, 0, NULL,
                    NULL, 0) == 0,
          "main FUTEX_LOCK_PI");

  pthread_t t_pi;
  require(pthread_create(&t_pi, NULL, pi_worker, &pctx) == 0,
          "pthread_create pi");
  while (atomic_load_explicit(&pctx.trylock_done, memory_order_acquire) == 0) {
    sched_yield();
  }
  struct timespec ts = {.tv_sec = 0, .tv_nsec = 5000000L};
  nanosleep(&ts, NULL);

  require(sys_futex(&pctx.lock, FUTEX_UNLOCK_PI | FUTEX_PRIVATE_FLAG, 0, NULL,
                    NULL, 0) == 0,
          "main FUTEX_UNLOCK_PI");
  require(pthread_join(t_pi, NULL) == 0, "pthread_join pi");
  require(atomic_load_explicit(&pctx.worker_acquired, memory_order_acquire) ==
              1,
          "worker acquired PI lock");
  require(pctx.lock == 0, "PI lock released to 0");

  struct bitset_ctx bctx;
  bctx.word = 0;
  atomic_init(&bctx.ready, 0);
  pthread_t t_bs;
  require(pthread_create(&t_bs, NULL, bitset_worker, &bctx) == 0,
          "pthread_create bitset");
  while (atomic_load_explicit(&bctx.ready, memory_order_acquire) == 0) {
    sched_yield();
  }
  nanosleep(&ts, NULL);

  require(sys_futex(&bctx.word, FUTEX_WAKE_BITSET | FUTEX_PRIVATE_FLAG, 1, NULL,
                    NULL, 0x02U) == 0,
          "FUTEX_WAKE_BITSET miss 0x02");
  __atomic_store_n(&bctx.word, 1U, __ATOMIC_RELEASE);
  long woke = sys_futex(&bctx.word, FUTEX_WAKE_BITSET | FUTEX_PRIVATE_FLAG, 1,
                        NULL, NULL, 0x04U);
  require(woke == 1, "FUTEX_WAKE_BITSET hit 0x04");
  require(pthread_join(t_bs, NULL) == 0, "pthread_join bitset");

  struct requeue_ctx rctx;
  rctx.src = 0;
  rctx.dst = 0;
  atomic_init(&rctx.ready, 0);
  pthread_t t_rq;
  require(pthread_create(&t_rq, NULL, requeue_worker, &rctx) == 0,
          "pthread_create requeue");
  while (atomic_load_explicit(&rctx.ready, memory_order_acquire) == 0) {
    sched_yield();
  }
  nanosleep(&ts, NULL);

  long req = sys_futex(&rctx.src, FUTEX_CMP_REQUEUE | FUTEX_PRIVATE_FLAG, 0,
                       (const struct timespec *)(uintptr_t)1U, &rctx.dst, 0);
  require(req == 1, "FUTEX_CMP_REQUEUE moved 1");
  __atomic_store_n(&rctx.dst, 1U, __ATOMIC_RELEASE);
  require(sys_futex(&rctx.dst, FUTEX_WAKE | FUTEX_PRIVATE_FLAG, 1, NULL, NULL,
                    0) == 1,
          "FUTEX_WAKE dst");
  require(pthread_join(t_rq, NULL) == 0, "pthread_join requeue");

  printf("futex-pi-runtime: ok pi=1 bitset=1 requeue=1\n");
  return 0;
}
