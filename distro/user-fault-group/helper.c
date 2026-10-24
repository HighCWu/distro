// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static atomic_int ready, go, worker_tid;

static long long now_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) _Exit(81);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void *worker(void *argument)
{
    const char *mode = argument;
    atomic_store(&worker_tid, (int)syscall(SYS_gettid, 0L, 0L, 0L, 0L, 0L, 0L));
    atomic_store_explicit(&ready, 1, memory_order_release);
    while (!atomic_load_explicit(&go, memory_order_acquire)) usleep(1000);
    if (!strcmp(mode, "thread-exit")) {
        syscall(SYS_exit, 73L, 0L, 0L, 0L, 0L, 0L);
        _Exit(82);
    }
#ifdef MODEL_THREAD_ONLY_EXIT
    /* Host-only negative control: emulate the former per-thread exit. */
    syscall(SYS_exit, 11L, 0L, 0L, 0L, 0L, 0L);
#elif defined(__wasm__)
    if (!strcmp(mode, "unreachable")) __builtin_trap();
    uintptr_t end = (uintptr_t)__builtin_wasm_memory_size(0) * 65536UL;
    volatile uint32_t value = *(volatile uint32_t *)end;
    (void)value;
#else
    raise(SIGSEGV);
#endif
    _Exit(83);
}

int main(int argc, char **argv)
{
    if (argc != 2 || (strcmp(argv[1], "unreachable") && strcmp(argv[1], "bounds") &&
                      strcmp(argv[1], "thread-exit"))) return 84;
    pthread_t thread;
    if (pthread_create(&thread, NULL, worker, argv[1])) return 85;
    long long deadline = now_ms() + 10000;
    while (!atomic_load_explicit(&ready, memory_order_acquire)) {
        if (now_ms() >= deadline) _Exit(86);
        usleep(1000);
    }
    int tid = atomic_load(&worker_tid);
    if (tid <= 0) _Exit(87);
    atomic_store_explicit(&go, 1, memory_order_release);
    deadline = now_ms() + 5000;
    if (!strcmp(argv[1], "thread-exit")) {
        for (;;) {
            errno = 0;
            long result = syscall(SYS_tgkill, (long)getpid(), (long)tid, 0L, 0L, 0L, 0L);
            if (result == -1 && errno == ESRCH) _Exit(37);
            if (result != 0 || now_ms() >= deadline) _Exit(88);
            usleep(1000);
        }
    }
    /* A live sibling after a fatal trap must produce a concrete failing exit
     * status, not be mistaken for a successful timeout or rely on join cleanup. */
    while (now_ms() < deadline) usleep(1000);
    _Exit(90);
}
