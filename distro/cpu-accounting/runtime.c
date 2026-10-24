// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static _Thread_local volatile uint64_t checksum;
static volatile sig_atomic_t virtual_seen, prof_seen, handler_seen;

static void output(const char *text)
{
    size_t left = strlen(text);
    while (left) {
        ssize_t n = write(1, text, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) _Exit(2);
        text += n;
        left -= (size_t)n;
    }
}

static _Noreturn void fail(const char *message)
{
    const char prefix[] = "::vm-test::fail: cpu-accounting: ";
    output(prefix);
    output(message);
    output("\n");
    _Exit(1);
}

static void stage(const char *message)
{
    output(message);
    output("\n");
}

static uint64_t clock_ns(clockid_t id)
{
    struct timespec value;
    if (clock_gettime(id, &value) || value.tv_sec < 0 ||
        value.tv_nsec < 0 || value.tv_nsec >= 1000000000)
        fail("clock_gettime failed or returned invalid time");
    return (uint64_t)value.tv_sec * 1000000000 + (uint64_t)value.tv_nsec;
}

static uint64_t user_ns(void)
{
    struct rusage usage;
    if (getrusage(RUSAGE_THREAD, &usage) || usage.ru_utime.tv_sec < 0 ||
        usage.ru_utime.tv_usec < 0 || usage.ru_utime.tv_usec >= 1000000)
        fail("getrusage failed or returned invalid user time");
    return (uint64_t)usage.ru_utime.tv_sec * 1000000000 +
           (uint64_t)usage.ru_utime.tv_usec * 1000;
}

static uint64_t elapsed(clockid_t id, uint64_t before)
{
    uint64_t now = clock_ns(id);
    if (now < before) fail("clock sample went backwards");
    return now - before;
}

static uint64_t user_elapsed(uint64_t before)
{
    uint64_t now = user_ns();
    if (now < before) fail("user resource time went backwards");
    return now - before;
}

static void burn(uint64_t wanted)
{
    uint64_t start = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    uint64_t deadline = clock_ns(CLOCK_MONOTONIC) + UINT64_C(3000000000);
    uint64_t previous = start;
    do {
        for (int i = 0; i < 100000; ++i)
            checksum = (checksum * UINT64_C(1664525) + (unsigned)i) ^ (checksum >> 7);
        uint64_t current = clock_ns(CLOCK_THREAD_CPUTIME_ID);
        if (current < previous) fail("thread CPU clock went backwards");
        if (current - start >= wanted) return;
        previous = current;
    } while (clock_ns(CLOCK_MONOTONIC) < deadline);
    fail("thread CPU clock did not advance within bounded work");
}

static void sleep_ms(long ms)
{
    struct timespec value = { .tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000 };
    if (nanosleep(&value, NULL)) fail("bounded sleep interrupted unexpectedly");
}

static void handler(int sig)
{
    if (sig == SIGVTALRM) virtual_seen++;
    else if (sig == SIGPROF) prof_seen++;
    else if (sig == SIGUSR1) {
        burn(UINT64_C(30000000));
        handler_seen++;
    }
}

struct thread_result { atomic_int ready; uint64_t elapsed; };
static void *thread_main(void *argument)
{
    struct thread_result *result = argument;
    uint64_t start = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    atomic_store_explicit(&result->ready, 1, memory_order_release);
    burn(UINT64_C(40000000));
    result->elapsed = elapsed(CLOCK_THREAD_CPUTIME_ID, start);
    return NULL;
}

int main(void)
{
    struct sigaction action = { .sa_handler = handler }, old[3];
    const int signals[] = { SIGVTALRM, SIGPROF, SIGUSR1 };
    sigemptyset(&action.sa_mask);
    for (int i = 0; i < 3; ++i)
        if (sigaction(signals[i], &action, &old[i])) fail("installing handlers failed");
    burn(UINT64_C(20000000)); // Warm the ordinary clock and entry paths.
    uint64_t user_before = user_ns();
    uint64_t process_before = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    burn(UINT64_C(60000000));
    if (user_elapsed(user_before) < UINT64_C(20000000) ||
        elapsed(CLOCK_PROCESS_CPUTIME_ID, process_before) < UINT64_C(50000000))
        fail("user execution was not charged to user/process CPU time");
    stage("cpu-accounting: thread/process clocks and getrusage user computation pass");

    struct itimerval timer = { .it_value = { .tv_usec = 20000 } }, remaining;
    if (setitimer(ITIMER_VIRTUAL, &timer, NULL)) fail("arming virtual timer failed");
    uint64_t thread_before = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    uint64_t wall_before = clock_ns(CLOCK_MONOTONIC);
    sleep_ms(150);
    uint64_t wall_delta = elapsed(CLOCK_MONOTONIC, wall_before);
    uint64_t cpu_delta = elapsed(CLOCK_THREAD_CPUTIME_ID, thread_before);
    if (virtual_seen || cpu_delta > wall_delta * 3 / 5 ||
        getitimer(ITIMER_VIRTUAL, &remaining) ||
        (!remaining.it_value.tv_sec && !remaining.it_value.tv_usec))
        fail("blocked sleep consumed the user CPU timer or excessive logical CPU time");
    stage("cpu-accounting: blocked wait excluded from logical CPU/user timer pass");

    timer.it_value.tv_usec = 10000;
    if (setitimer(ITIMER_PROF, &timer, NULL)) fail("arming profiling timer failed");
    burn(UINT64_C(80000000));
    if (virtual_seen != 1 || prof_seen != 1)
        fail("virtual/profiling CPU timer did not deliver exactly once");
    memset(&timer, 0, sizeof timer);
    if (setitimer(ITIMER_VIRTUAL, &timer, NULL) || setitimer(ITIMER_PROF, &timer, NULL))
        fail("disarming CPU timers failed");
    user_before = user_ns();
    if (kill(getpid(), SIGUSR1) || handler_seen != 1 ||
        user_elapsed(user_before) < UINT64_C(15000000))
        fail("signal handler computation was not charged as user time");
    stage("cpu-accounting: virtual/profiling timers and handler user computation pass");

    struct thread_result result = {0};
    atomic_init(&result.ready, 0);
    pthread_t thread;
    process_before = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    if (pthread_create(&thread, NULL, thread_main, &result)) fail("creating CPU worker failed");
    uint64_t deadline = clock_ns(CLOCK_MONOTONIC) + UINT64_C(3000000000);
    while (!atomic_load_explicit(&result.ready, memory_order_acquire)) {
        if (clock_ns(CLOCK_MONOTONIC) >= deadline) fail("CPU worker did not start");
        sched_yield();
    }
    thread_before = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    sleep_ms(100);
    void *returned;
    if (pthread_join(thread, &returned) || returned) fail("joining CPU worker failed");
    if (elapsed(CLOCK_THREAD_CPUTIME_ID, thread_before) >= UINT64_C(20000000) ||
        result.elapsed < UINT64_C(40000000) ||
        elapsed(CLOCK_PROCESS_CPUTIME_ID, process_before) < result.elapsed)
        fail("thread CPU clocks were not isolated or process time lost a joined thread");
    for (int i = 0; i < 3; ++i)
        if (sigaction(signals[i], &old[i], NULL)) fail("restoring handlers failed");
    stage("cpu-accounting: thread isolation, joined process time and cleanup pass");
    stage("::vm-test::pass");
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
