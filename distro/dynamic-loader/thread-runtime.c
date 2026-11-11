// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in the isolated Linux/Wasm dynamic loading image"
#endif
#include <dlfcn.h>
#include <errno.h>
#include <link.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static volatile uint32_t process_value = 0x13579bdf;
static _Thread_local volatile uint32_t thread_value = 0x2468ace0;

struct thread_request {
  uint32_t expected_process;
  uint32_t process_increment;
  uint32_t thread_value;
  uint32_t nested_increment;
  uint32_t nested_thread_value;
};

struct nested_thread_request {
  uint32_t expected_process;
  uint32_t process_increment;
  uint32_t thread_value;
};

static void require(int condition, const char *message)
{
  if (condition) return;
  fprintf(stderr, "::vm-test::fail: dynamic pthread: %s errno=%d\n", message, errno);
  exit(1);
}

static void *nested_thread_main(void *opaque);

static void *thread_main(void *opaque)
{
  const struct thread_request *request = opaque;
  if (process_value != request->expected_process) return (void *)(uintptr_t)1;
  if (thread_value != 0x2468ace0) return (void *)(uintptr_t)2;

  thread_value = request->thread_value;
  errno = EDOM;
  if (thread_value != request->thread_value || errno != EDOM) return (void *)(uintptr_t)3;

  struct nested_thread_request nested_request = {
      .expected_process = process_value,
      .process_increment = request->nested_increment,
      .thread_value = request->nested_thread_value,
  };
  pthread_t nested_thread;
  int error = pthread_create(&nested_thread, NULL, nested_thread_main, &nested_request);
  if (error) return (void *)(uintptr_t)4;
  void *nested_result = (void *)(uintptr_t)UINTPTR_MAX;
  error = pthread_join(nested_thread, &nested_result);
  if (error || nested_result != NULL) return (void *)(uintptr_t)5;
  if (process_value != request->expected_process + request->nested_increment ||
      thread_value != request->thread_value || errno != EDOM)
    return (void *)(uintptr_t)6;

  __atomic_fetch_add(&process_value, request->process_increment, __ATOMIC_SEQ_CST);
  return NULL;
}

static void *nested_thread_main(void *opaque)
{
  const struct nested_thread_request *request = opaque;
  if (process_value != request->expected_process) return (void *)(uintptr_t)1;
  if (thread_value != 0x2468ace0) return (void *)(uintptr_t)2;

  thread_value = request->thread_value;
  errno = ERANGE;
  if (thread_value != request->thread_value || errno != ERANGE) return (void *)(uintptr_t)3;
  __atomic_fetch_add(&process_value, request->process_increment, __ATOMIC_SEQ_CST);
  return NULL;
}

static void run_thread_cycle(uint32_t increment, uint32_t child_tls,
                             uint32_t nested_increment, uint32_t nested_tls)
{
  const uint32_t before = process_value;
  struct thread_request request = {
      .expected_process = before,
      .process_increment = increment,
      .thread_value = child_tls,
      .nested_increment = nested_increment,
      .nested_thread_value = nested_tls,
  };
  const uint32_t parent_tls = thread_value;
  const int parent_errno = errno;
  pthread_t thread;
  int error = pthread_create(&thread, NULL, thread_main, &request);
  require(error == 0, "pthread_create");

  void *result = (void *)(uintptr_t)UINTPTR_MAX;
  error = pthread_join(thread, &result);
  require(error == 0 && result == NULL, "pthread_join and child checks");
  require(process_value == before + increment + nested_increment,
          "shared process data survives nested thread startup");
  require(thread_value == parent_tls, "parent TLS remains private");
  require(errno == parent_errno, "parent errno remains private");
}

int main(void)
{
  setvbuf(stdout, NULL, _IONBF, 0);
  require(process_value == 0x13579bdf, "initial process data");
  require(thread_value == 0x2468ace0, "initial TLS template");
  puts("dynamic pthread: initial shared-memory and TLS state pass");

  process_value = 0x89abcdef;
  thread_value = 0xfedcba98;
  errno = EBUSY;
  run_thread_cycle(7, 0x11112222, 3, 0x55556666);
  run_thread_cycle(13, 0x33334444, 5, 0x77778888);
  require(process_value == 0x89abce0b, "two nested pthread cycles update shared process data");
  require(thread_value == 0xfedcba98, "both thread TLS instances leave parent TLS unchanged");
  require(errno == EBUSY, "both thread cycles leave parent errno unchanged");
  puts("dynamic pthread: nested callback clone/join cycles preserve globals, TLS and errno");

  errno = EBUSY;
  void *library = dlopen("libmust-not-load-after-thread.so", RTLD_NOW | RTLD_LOCAL);
  require(library == NULL, "dlopen remains disabled after thread creation");
  const char *message = dlerror();
  require(message != NULL && *message != '\0', "blocked dlopen remains observable through dlerror");

  Dl_info info = { 0 };
  require(dladdr((void *)(uintptr_t)1, &info) == 0,
          "dladdr uses the i32 ABI and remains blocked after thread creation");
  require(dlerror() == NULL, "dladdr leaves the cleared dlerror state unchanged");
  require(errno == EBUSY, "blocked dlopen preserves parent errno");
  puts("dynamic pthread: DSO loading remains blocked after the first thread");
  puts("::vm-test::pass");
  for (;;) pause();
}
