// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef BENCH_FORK
#define BENCH_FORK 0
#endif
#ifndef BENCH_PAYLOAD_MIB
#define BENCH_PAYLOAD_MIB 1
#endif
#ifndef BENCH_ITERATIONS
#define BENCH_ITERATIONS 262144
#endif
#ifndef BENCH_SYSCALLS
#define BENCH_SYSCALLS 4096
#endif
#ifndef BENCH_SAMPLES
#define BENCH_SAMPLES 5
#endif

static void require(int ok, const char *message)
{
  if (ok) return;
  printf("::vm-test::fail: fork-bench: %s errno=%d\n", message, errno);
  fflush(stdout);
  _exit(120);
}
static uint64_t now(void)
{
  struct timespec t;
  require(!clock_gettime(CLOCK_MONOTONIC, &t), "clock");
  return (uint64_t)t.tv_sec * 1000000000ULL + (uint64_t)t.tv_nsec;
}
static uint64_t linear_bytes(void)
{
#ifdef __wasm__
  return (uint64_t)__builtin_wasm_memory_size(0) * 65536ULL;
#else
  return 0; // Native fixture checks have no Wasm linear memory.
#endif
}

#if !BENCH_FORK
static volatile uint32_t seed = 42;
__attribute__((noinline)) static uint32_t step(uint32_t x, unsigned int i)
{
  // A potential syscall makes this function continuation-reachable. Pure
  // arithmetic alone would allow Asyncify to omit its instrumentation.
  if ((i & 1023) == 0) require(getpid() > 0, "work identity");
  return (x ^ (x << 13)) + (uint32_t)i + UINT32_C(2654435761);
}
static void work(void)
{
  for (int sample = -1; sample < BENCH_SAMPLES; sample++) {
    uint32_t x = seed;
    uint64_t start = now();
    for (unsigned int i = 0; i < BENCH_ITERATIONS; i++) x = step(x, i);
    uint64_t elapsed = now() - start;
    if (sample >= 0)
      printf("fork-bench: {\"kind\":\"work\",\"phase\":\"calls\",\"sample\":%d,\"iterations\":%d,\"ns\":%" PRIu64 ",\"checksum\":%" PRIu32 ",\"linear_bytes\":%" PRIu64 "}\n",
        sample, BENCH_ITERATIONS, elapsed, x, linear_bytes());
    pid_t identity = getpid();
    unsigned int count = 0;
    start = now();
    for (unsigned int i = 0; i < BENCH_SYSCALLS; i++) count += getpid() == identity;
    elapsed = now() - start;
    require(count == BENCH_SYSCALLS, "syscall identity");
    if (sample >= 0)
      printf("fork-bench: {\"kind\":\"work\",\"phase\":\"syscalls\",\"sample\":%d,\"iterations\":%d,\"ns\":%" PRIu64 ",\"checksum\":%u,\"linear_bytes\":%" PRIu64 "}\n",
        sample, BENCH_SYSCALLS, elapsed, count, linear_bytes());
  }
}
#else
static _Thread_local volatile int tls_cookie = 73;
static void forks(void)
{
  const size_t bytes = (size_t)BENCH_PAYLOAD_MIB * 1024 * 1024;
  volatile unsigned char *payload = malloc(bytes);
  require(payload != NULL, "payload allocation");
  // Touch every 4 KiB, not only every 64 KiB Wasm page.
  for (size_t i = 0; i < bytes; i += 4096) payload[i] = (i / 4096) % 251;
  pid_t original = getpid();
  for (int sample = -1; sample < BENCH_SAMPLES; sample++) {
    volatile int stack_cookie = sample + 91;
    uint64_t linear = linear_bytes();
    uint64_t start = now();
    pid_t pid = fork();
    if (!pid) {
      require(getpid() != original && getppid() == original, "child identity");
      require(tls_cookie == 73 && stack_cookie == sample + 91, "child stack/TLS");
      require(payload[bytes / 2] == (bytes / 2 / 4096) % 251, "child snapshot");
      payload[bytes / 2] = 255;
      tls_cookie = 99;
      _exit(42);
    }
    uint64_t returned = now();
    require(pid > 0 && getpid() == original, "parent fork");
    int status;
    require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 42, "child wait");
    uint64_t reaped = now();
    require(tls_cookie == 73 && stack_cookie == sample + 91 &&
      payload[bytes / 2] == (bytes / 2 / 4096) % 251, "parent isolation");
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
    if (sample >= 0)
      printf("fork-bench: {\"kind\":\"fork\",\"sample\":%d,\"payload_bytes\":%zu,\"parent_ns\":%" PRIu64 ",\"wait_ns\":%" PRIu64 ",\"linear_bytes\":%" PRIu64 "}\n",
        sample, bytes, returned - start, reaped - start, linear);
  }
  free((void *)payload);
}
#endif

int main(void)
{
#if BENCH_FORK
  forks();
#else
  work();
#endif
  puts("::vm-test::pass");
  fflush(stdout);
#ifdef __wasm__
  for (;;) sched_yield();
#endif
  return 0;
}
