// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run this check only in its isolated Linux runtime image"
#endif

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <semaphore.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static sem_t child_gate;
static pthread_t child_thread;
static _Atomic int child_ready;
static _Atomic int child_joined;
static _Atomic long child_tid;

static void fail(const char *stage, int error)
{
  fprintf(stdout, "::vm-test::fail: worker publication: %s errno=%d (%s)\n", stage, error,
          error ? strerror(error) : "none");
  fflush(stdout);
  for (;;) (void)sched_yield();
}

static void *blocked_child(void *unused)
{
  (void)unused;
  atomic_store_explicit(&child_tid, syscall(SYS_gettid), memory_order_release);
  atomic_store_explicit(&child_ready, 1, memory_order_release);
  int result;
  do {
    result = sem_wait(&child_gate);
  } while (result != 0 && errno == EINTR);
  return result == 0 ? NULL : (void *)(uintptr_t)1;
}

// Called by the constructor DSO after publication completes. The child exists
// before dlopen begins and must be able to exit while the loader is in ctor code.
int worker_publication_release_and_join(void)
{
  if (!atomic_load_explicit(&child_ready, memory_order_acquire) ||
      atomic_load_explicit(&child_joined, memory_order_acquire))
    return EINVAL;
  if (sem_post(&child_gate) != 0) return errno;

  void *result = NULL;
  int error = pthread_join(child_thread, &result);
  if (error != 0) return error;
  if (result != NULL) return ECHILD;
  atomic_store_explicit(&child_joined, 1, memory_order_release);
  return 0;
}

static int task_state(long tid, char *state)
{
  char path[96];
  int length = snprintf(path, sizeof(path), "/proc/self/task/%ld/stat", tid);
  if (length <= 0 || (size_t)length >= sizeof(path)) return EOVERFLOW;
  int fd = open(path, 0);
  if (fd < 0) return errno;
  char buffer[1024];
  ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
  int read_error = errno;
  (void)close(fd);
  if (count < 0) return read_error;
  if (count == 0) return EIO;
  buffer[count] = '\0';
  char *last_paren = strrchr(buffer, ')');
  if (!last_paren || last_paren[1] != ' ' || last_paren[2] == '\0') return EIO;
  *state = last_paren[2];
  return 0;
}

static long monotonic_millis(void)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (long)(now.tv_sec * 1000 + now.tv_nsec / 1000000);
}

static void sleep_millis(long millis)
{
  struct timespec delay = {.tv_sec = millis / 1000, .tv_nsec = (millis % 1000) * 1000000};
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
}

typedef int (*publication_value_fn)(void);
typedef int (*constructor_count_fn)(void);
typedef int (*constructor_status_fn)(void);
typedef int (*after_value_fn)(void);

static void *later_thread(void *unused)
{
  (void)unused;
  return (void *)(uintptr_t)42;
}

static void *symbol(void *handle, const char *name, int *error)
{
  (void)dlerror();
  void *result = dlsym(handle, name);
  const char *message = dlerror();
  *error = result && !message ? 0 : ENOENT;
  return result;
}

int main(void)
{
  setvbuf(stdout, NULL, _IONBF, 0);
  if (mount("proc", "/proc", "proc", 0, NULL) != 0) fail("mount procfs", errno);
  if (sem_init(&child_gate, 0, 0) != 0) fail("initialize child semaphore", errno);

  int error = pthread_create(&child_thread, NULL, blocked_child, NULL);
  if (error != 0) fail("create existing child", error);
  long deadline = monotonic_millis();
  if (deadline < 0) fail("read monotonic clock", errno);
  deadline += 10000;

  long tid = -1;
  char state = '?';
  for (;;) {
    if (atomic_load_explicit(&child_ready, memory_order_acquire))
      tid = atomic_load_explicit(&child_tid, memory_order_acquire);
    if (tid >= 0) {
      error = task_state(tid, &state);
      if (error != 0) fail("read child task state", error);
      if (state == 'S') break;
    }
    long now = monotonic_millis();
    if (now < 0) fail("read monotonic clock", errno);
    if (now >= deadline) fail("wait for child semaphore", ETIMEDOUT);
    sleep_millis(1);
  }

  puts("WORKER_FIRST_THREAD_BLOCKED_BEFORE_DLOPEN");
  void *constructor_module = dlopen("/plugins/libworker-publication-constructor.so",
                                    RTLD_NOW | RTLD_LOCAL);
  if (!constructor_module) fail("load constructor library", ENOENT);

  int symbol_error = 0;
  publication_value_fn value = (publication_value_fn)symbol(constructor_module,
                                                             "worker_publication_value",
                                                             &symbol_error);
  if (symbol_error || !value) fail("resolve constructor library value", symbol_error);
  constructor_count_fn count = (constructor_count_fn)symbol(constructor_module,
                                                            "worker_publication_constructor_count",
                                                            &symbol_error);
  if (symbol_error || !count) fail("resolve constructor count", symbol_error);
  constructor_status_fn status = (constructor_status_fn)symbol(constructor_module,
                                                                "worker_publication_constructor_status",
                                                                &symbol_error);
  if (symbol_error || !status) fail("resolve constructor status", symbol_error);
  if (value() != 42 || count() != 1 || status() != 0 ||
      !atomic_load_explicit(&child_joined, memory_order_acquire))
    fail("constructor released and joined child", EPROTO);
  if (sem_destroy(&child_gate) != 0) fail("destroy child semaphore", errno);

  pthread_t later;
  error = pthread_create(&later, NULL, later_thread, NULL);
  if (error != 0) fail("create thread after constructor", error);
  void *later_result = NULL;
  error = pthread_join(later, &later_result);
  if (error != 0 || later_result != (void *)(uintptr_t)42)
    fail("join thread after constructor", error ? error : ECHILD);

  void *after_module = dlopen("/plugins/libworker-publication-after.so", RTLD_NOW | RTLD_LOCAL);
  if (!after_module) fail("load second library", ENOENT);
  after_value_fn after_value = (after_value_fn)symbol(after_module,
                                                       "worker_publication_after_value",
                                                       &symbol_error);
  if (symbol_error || !after_value || after_value() != 42)
    fail("call second library", symbol_error ? symbol_error : EPROTO);

  puts("WORKER_PUBLICATION_CTOR_JOIN_OK");
  puts("::vm-test::pass");
  for (;;) (void)sched_yield();
}
