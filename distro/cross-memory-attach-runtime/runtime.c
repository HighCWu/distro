#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>

#define BUF_A_LEN 256U
#define BUF_B_LEN 8192U
#define BUF_C_LEN 512U
#define TOTAL_LEN (BUF_A_LEN + BUF_B_LEN + BUF_C_LEN)
#define LOCAL_0_LEN 4096U
#define LOCAL_1_LEN (TOTAL_LEN - LOCAL_0_LEN)

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "cross-memory-attach-runtime: %s (errno=%d: %s)\n", what,
          errno, strerror(errno));
  exit(1);
}

struct worker_state {
  pthread_mutex_t mu;
  pthread_cond_t cv;
  int ready;
  int write_done;
  uint8_t *buf_a;
  uint8_t *buf_b;
  uint8_t *buf_c;
};

static uint8_t read_pattern(size_t idx) {
  return (uint8_t)((idx * 73U + 19U) & 0xffU);
}

static uint8_t write_pattern(size_t idx) {
  return (uint8_t)((idx * 149U + 91U) & 0xffU);
}

static void *worker_fn(void *arg) {
  struct worker_state *st = (struct worker_state *)arg;

  uint8_t *a = malloc(BUF_A_LEN);
  uint8_t *b = malloc(BUF_B_LEN);
  uint8_t *c = malloc(BUF_C_LEN);
  require(a != NULL && b != NULL && c != NULL, "worker malloc");

  for (size_t i = 0; i < BUF_A_LEN; i++) {
    a[i] = read_pattern(i);
  }
  for (size_t i = 0; i < BUF_B_LEN; i++) {
    b[i] = read_pattern(BUF_A_LEN + i);
  }
  for (size_t i = 0; i < BUF_C_LEN; i++) {
    c[i] = read_pattern(BUF_A_LEN + BUF_B_LEN + i);
  }

  pthread_mutex_lock(&st->mu);
  st->buf_a = a;
  st->buf_b = b;
  st->buf_c = c;
  st->ready = 1;
  pthread_cond_signal(&st->cv);
  while (!st->write_done) {
    pthread_cond_wait(&st->cv, &st->mu);
  }
  pthread_mutex_unlock(&st->mu);

  for (size_t i = 0; i < BUF_A_LEN; i++) {
    require(a[i] == write_pattern(i), "worker verify buf_a");
  }
  for (size_t i = 0; i < BUF_B_LEN; i++) {
    require(b[i] == write_pattern(BUF_A_LEN + i), "worker verify buf_b");
  }
  for (size_t i = 0; i < BUF_C_LEN; i++) {
    require(c[i] == write_pattern(BUF_A_LEN + BUF_B_LEN + i),
            "worker verify buf_c");
  }

  free(a);
  free(b);
  free(c);
  return NULL;
}

int main(void) {
  struct worker_state st;
  memset(&st, 0, sizeof(st));
  require(pthread_mutex_init(&st.mu, NULL) == 0, "pthread_mutex_init");
  require(pthread_cond_init(&st.cv, NULL) == 0, "pthread_cond_init");

  pthread_t tid;
  require(pthread_create(&tid, NULL, worker_fn, &st) == 0, "pthread_create");

  pthread_mutex_lock(&st.mu);
  while (!st.ready) {
    pthread_cond_wait(&st.cv, &st.mu);
  }
  uint8_t *a = st.buf_a;
  uint8_t *b = st.buf_b;
  uint8_t *c = st.buf_c;
  pthread_mutex_unlock(&st.mu);

  uint8_t *loc0 = malloc(LOCAL_0_LEN);
  uint8_t *loc1 = malloc(LOCAL_1_LEN);
  require(loc0 != NULL && loc1 != NULL, "local malloc");

  struct iovec r_iov[3] = {
      {.iov_base = a, .iov_len = BUF_A_LEN},
      {.iov_base = b, .iov_len = BUF_B_LEN},
      {.iov_base = c, .iov_len = BUF_C_LEN},
  };
  struct iovec l_iov[2] = {
      {.iov_base = loc0, .iov_len = LOCAL_0_LEN},
      {.iov_base = loc1, .iov_len = LOCAL_1_LEN},
  };

  pid_t self_pid = getpid();
  ssize_t nr = process_vm_readv(self_pid, l_iov, 2, r_iov, 3, 0);
  require(nr == (ssize_t)TOTAL_LEN, "process_vm_readv");

  for (size_t i = 0; i < LOCAL_0_LEN; i++) {
    require(loc0[i] == read_pattern(i), "read verify loc0");
  }
  for (size_t i = 0; i < LOCAL_1_LEN; i++) {
    require(loc1[i] == read_pattern(LOCAL_0_LEN + i), "read verify loc1");
  }

  for (size_t i = 0; i < LOCAL_0_LEN; i++) {
    loc0[i] = write_pattern(i);
  }
  for (size_t i = 0; i < LOCAL_1_LEN; i++) {
    loc1[i] = write_pattern(LOCAL_0_LEN + i);
  }

  ssize_t nw = process_vm_writev(self_pid, l_iov, 2, r_iov, 3, 0);
  require(nw == (ssize_t)TOTAL_LEN, "process_vm_writev");

  pthread_mutex_lock(&st.mu);
  st.write_done = 1;
  pthread_cond_signal(&st.cv);
  pthread_mutex_unlock(&st.mu);

  require(pthread_join(tid, NULL) == 0, "pthread_join");
  pthread_cond_destroy(&st.cv);
  pthread_mutex_destroy(&st.mu);

  char err_buf[64];
  struct iovec err_local = {.iov_base = err_buf, .iov_len = sizeof(err_buf)};
  struct iovec bad_remote = {.iov_base = (void *)(uintptr_t)0x1000U,
                             .iov_len = sizeof(err_buf)};
  ssize_t ef = process_vm_readv(self_pid, &err_local, 1, &bad_remote, 1, 0);
  require(ef == -1 && errno == EFAULT, "process_vm_readv EFAULT");

  struct iovec good_remote = {.iov_base = loc0, .iov_len = sizeof(err_buf)};
  ssize_t es =
      process_vm_readv((pid_t)999999, &err_local, 1, &good_remote, 1, 0);
  require(es == -1 && errno == ESRCH, "process_vm_readv ESRCH");

  free(loc0);
  free(loc1);

  printf("cross-memory-attach-runtime: ok pid=%d bytes=%u\n", (int)self_pid,
         TOTAL_LEN);
  return 0;
}
