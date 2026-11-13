// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run this check only in its isolated Linux runtime image"
#endif

#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static _Atomic int worker_released;
static _Atomic int worker_error;
static _Atomic int constructor_entered;
static pthread_t owner_thread;
static volatile sig_atomic_t owner_signal_seen;

static void fail(const char *stage, int error)
{
  fprintf(stderr, "::vm-test::fail: dynamic-loader maintenance: %s errno=%d (%s)\n", stage,
          error, error ? strerror(error) : "none");
  fflush(stderr);
  exit(1);
}

static void owner_signal(int signal_number)
{
  if (signal_number == SIGUSR1) owner_signal_seen = 1;
}

static void *timer_worker(void *unused)
{
  (void)unused;

  // Start the timer only after the loader has entered the constructor loop.
  while (!atomic_load_explicit(&constructor_entered, memory_order_acquire)) {}

  struct timespec delay = {.tv_sec = 0, .tv_nsec = 5000000};
  int sleep_result;
  do {
    sleep_result = nanosleep(&delay, &delay);
  } while (sleep_result != 0 && errno == EINTR);

  int error = sleep_result == 0 ? pthread_kill(owner_thread, SIGUSR1) : errno;
  atomic_store_explicit(&worker_error, error, memory_order_relaxed);
  atomic_store_explicit(&worker_released, 1, memory_order_release);
  return NULL;
}

__attribute__((visibility("default"))) int loader_maintenance_is_released(void)
{
  return atomic_load_explicit(&worker_released, memory_order_acquire);
}

__attribute__((visibility("default"))) int loader_maintenance_ctor_entered(void)
{
  atomic_store_explicit(&constructor_entered, 1, memory_order_release);
  return 0;
}

__attribute__((visibility("default"))) int loader_maintenance_signal_seen(void)
{
  return owner_signal_seen != 0;
}

typedef int (*int_fn)(void);

static void *lookup(void *handle, const char *name)
{
  (void)dlerror();
  void *result = dlsym(handle, name);
  const char *error = dlerror();
  return error ? NULL : result;
}

int main(void)
{
  setvbuf(stdout, NULL, _IONBF, 0);
  struct sigaction action = {.sa_handler = owner_signal};
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGUSR1, &action, NULL) != 0) fail("install owner signal handler", errno);

  owner_thread = pthread_self();
  pthread_t timer;
  int error = pthread_create(&timer, NULL, timer_worker, NULL);
  if (error != 0) fail("create timer worker", error);

  void *handle = dlopen("/plugins/libloader-maintenance.so", RTLD_NOW | RTLD_LOCAL);
  if (!handle) {
    const char *message = dlerror();
    fprintf(stderr, "::vm-test::fail: dynamic-loader maintenance: dlopen: %s\n",
            message ? message : "unknown error");
    exit(1);
  }

  int_fn constructor_status = (int_fn)lookup(handle, "loader_maintenance_ctor_status");
  int_fn constructor_signal = (int_fn)lookup(handle, "loader_maintenance_ctor_signal_seen");
  if (!constructor_status || !constructor_signal)
    fail("resolve constructor results", ENOENT);
  if (constructor_status() != 0) fail("timer worker did not release constructor", ETIMEDOUT);
  if (constructor_signal() != 0)
    fail("owner signal was delivered inside the loader operation", EPROTO);

  void *worker_result = NULL;
  error = pthread_join(timer, &worker_result);
  if (error != 0 || worker_result != NULL)
    fail("join timer worker", error ? error : ECHILD);
  if (atomic_load_explicit(&worker_error, memory_order_relaxed) != 0)
    fail("send owner-directed signal", atomic_load_explicit(&worker_error, memory_order_relaxed));
  if (!owner_signal_seen) fail("deliver owner signal after dlopen", EPROTO);

  puts("DYNAMIC_LOADER_MAINTENANCE_OK");
  puts("::vm-test::pass");
  for (;;) pause();
}
