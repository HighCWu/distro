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
#ifndef LATENCY_MIB
#define LATENCY_MIB 1
#endif
#ifndef LATENCY_EXEC
#define LATENCY_EXEC 0
#endif
#ifndef LATENCY_SAMPLES
#define LATENCY_SAMPLES 30
#endif
static _Thread_local volatile int cookie = 73;
static void require(int ok, const char *why)
{
  if (ok) return;
  printf("::vm-test::fail: latency %s errno=%d\n", why, errno);
  fflush(stdout);
  _exit(120);
}
static uint64_t now(void)
{
  struct timespec t;
  require(!clock_gettime(CLOCK_MONOTONIC, &t), "clock");
  return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}
int main(int argc, char **argv)
{
  char *helper;
#ifdef __wasm__
  (void)argc;
  (void)argv;
  helper = "/latency-helper";
#else
  require(argc == 2, "helper argument");
  helper = argv[1];
#endif
  const size_t bytes = (size_t)LATENCY_MIB * 1024 * 1024;
  volatile unsigned char *payload = malloc(bytes);
  require(payload != NULL, "allocation");
  for (size_t i = 0; i < bytes; i += 4096) payload[i] = (i / 4096) % 251;
  pid_t parent = getpid();
  char parent_text[32];
  require(snprintf(parent_text, sizeof(parent_text), "%ld", (long)parent) > 0, "parent text");
  char *arguments[] = {helper, "latency-exec-v1", parent_text, NULL};
  char *environment[] = {"LATENCY_TOKEN=verified", NULL};
  for (int sample = -1; sample < LATENCY_SAMPLES; sample++) {
    volatile int stack = sample + 91;
    uint64_t linear = 0;
#ifdef __wasm__
    linear = (uint64_t)__builtin_wasm_memory_size(0) * 65536;
#endif
    uint64_t start = now();
    pid_t child = fork();
    if (!child) {
      require(getpid() != parent && getppid() == parent, "child identity");
      require(stack == sample + 91 && cookie == 73, "child stack/TLS");
      for (size_t i = 0; i < bytes; i += 4096) require(payload[i] == (i / 4096) % 251, "snapshot");
      payload[bytes / 2] = 255;
      cookie = 99;
#if LATENCY_EXEC
      execve(arguments[0], arguments, environment);
      require(0, "exec returned");
#endif
      _exit(42);
    }
    uint64_t returned = now();
    require(child > 0 && getpid() == parent, "parent fork");
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 42, "wait");
    uint64_t reaped = now();
    require(cookie == 73 && stack == sample + 91 && payload[bytes / 2] == (bytes / 2 / 4096) % 251, "parent isolation");
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
    if (sample >= 0) printf("fork-latency: {\"sample\":%d,\"exec\":%d,\"payload_bytes\":%zu,\"linear_bytes\":%" PRIu64 ",\"parent_ns\":%" PRIu64 ",\"wait_ns\":%" PRIu64 "}\n", sample, LATENCY_EXEC, bytes, linear, returned - start, reaped - start);
  }
  (void)arguments;
  (void)environment;
  free((void *)payload);
  puts("::vm-test::pass");
  fflush(stdout);
#ifdef __wasm__
  for (;;) sched_yield();
#endif
  return 0;
}
