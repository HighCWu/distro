// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#ifdef FORK_LIBRARY_POLL
#include <pthread.h>
#include <sched.h>
#endif
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef FORK_LIBRARY_POLL
#include <string.h>
#endif
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile int marker = 11, expected = 11;
static volatile sig_atomic_t received, bad;
#ifndef FORK_POLL_NATIVE_REFERENCE
static volatile sig_atomic_t try_fork;
#endif
static volatile int private_value = 61;
#ifdef FORK_LIBRARY_POLL
static volatile sig_atomic_t library_test, library_active;
static void *(*volatile search_bytes)(const void *, int, size_t) = memchr;
#endif
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: fork poll: %s errno=%d\n", what, errno);
    exit(1);
}
static void handler(int sig)
{
#ifdef FORK_LIBRARY_POLL
    if (library_test && !library_active) bad = 1;
#endif
    if (sig != SIGALRM || marker != expected) bad = 1;
#ifndef FORK_POLL_NATIVE_REFERENCE
    if (try_fork) {
        int saved = errno;
        if (fork() != -1 || errno != EOPNOTSUPP) bad = 1;
        errno = saved;
    }
#endif
    received++;
}
static void compute(void)
{
    received = 0;
    struct itimerval timer = { .it_value = { .tv_usec = 50000 } };
    require(setitimer(ITIMER_REAL, &timer, NULL) == 0, "arm standard timer");
    /* No syscall or clock read: actual compiler checkpoints must enter Linux. */
    uint64_t count = 0;
    while (!received && count < (UINT64_C(1) << 33)) count++;
    require(received && !bad && marker == expected, "timer during pure computation");
}
static void reap(pid_t pid, int code)
{
    int status;
    require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == code,
            "exact continuation child status");
    errno = 0;
    require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single reaping");
}
#ifdef FORK_LIBRARY_POLL
/* Keep application checkpoints out of the wrapper: only the libc search loop
 * may deliver this timer while library_active is set. */
__attribute__((noinline))
#ifdef __clang__
__attribute__((no_sanitize("coverage")))
#endif
static int library_scan(const void *bytes, size_t size)
{
    library_active = 1;
    for (unsigned int scan = 0; scan < 512 && !received; scan++) {
        if (search_bytes(bytes, 0xff, size) != NULL) bad = 1;
    }
    library_active = 0;
    return received && !bad;
}

static void library_compute(const void *bytes, size_t size)
{
    received = 0;
    bad = 0;
    library_test = 1;
    struct itimerval timer = { .it_value = { .tv_usec = 50000 } };
    require(setitimer(ITIMER_REAL, &timer, NULL) == 0,
            "arm library computation timer");
    require(library_scan(bytes, size),
            "timer while application calls libc memchr");
    library_test = 0;
    require(!bad && marker == expected && !library_active,
            "library computation TLS and callback state");
}

static void *thread_tls_probe(void *unused)
{
    (void)unused;
    marker = expected = 44;
    return marker == expected ? NULL : (void *)(uintptr_t)1;
}

static pid_t fork_after_join(void)
{
    for (int attempt = 0; attempt < 1000; attempt++) {
        pid_t child = fork();
        if (child >= 0) return child;
        require(errno == EOPNOTSUPP, "unexpected fork-after-join failure");
        sched_yield();
    }
    return -1;
}
#endif
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    struct sigaction action = { .sa_handler = handler };
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGALRM, &action, NULL) == 0, "install handler");
    compute();
    puts("fork poll: compiler checkpoints deliver timer before continuation fork pass");
    for (int round = 0; round < 2; round++) {
        pid_t child = fork();
        require(child >= 0, "ordinary fork");
        if (!child) {
            marker = expected = 22; private_value = 99;
            compute();
            pid_t grandchild = fork();
            require(grandchild >= 0, "nested process fork");
            if (!grandchild) {
                marker = expected = 33; private_value = 101;
                compute();
                _exit(38);
            }
            reap(grandchild, 38);
            require(marker == 22 && private_value == 99, "child private TLS and globals");
            compute();
            _exit(37);
        }
        compute();
        reap(child, 37);
        require(marker == 11 && private_value == 61, "parent private TLS and globals");
    }
    puts("fork poll: parent child grandchild computation, private TLS and repeated fork wait pass");
#ifndef FORK_POLL_NATIVE_REFERENCE
    try_fork = 1;
    compute();
    try_fork = 0;
#endif
    pid_t child = fork();
    require(child >= 0, "later fork after callback refusal");
    if (!child) { compute(); _exit(39); }
    reap(child, 39);
    compute();
#ifdef FORK_POLL_NATIVE_REFERENCE
    puts("fork poll native: ordinary recovery fork and timer pass");
#else
    puts("fork poll: signal callback fork stays refused and later fork and timer recover pass");
#endif
#ifdef FORK_LIBRARY_POLL
    pthread_t thread;
    void *thread_result = (void *)1;
    require(pthread_create(&thread, NULL, thread_tls_probe, NULL) == 0,
            "create TLS probe thread");
    require(pthread_join(thread, &thread_result) == 0 && thread_result == NULL &&
            marker == 11 && expected == 11 && private_value == 61,
            "joined thread preserves parent TLS and globals");

    size_t library_size = 16U * 1024U * 1024U;
    unsigned char *library_bytes = malloc(library_size);
    require(library_bytes != NULL, "allocate libc search input");
    memset(library_bytes, 0x11, library_size);
    library_compute(library_bytes, library_size);

    pid_t library_child = fork_after_join();
    require(library_child >= 0, "fork after joined pthread");
    if (!library_child) {
        marker = expected = 22;
        private_value = 99;
        library_compute(library_bytes, library_size);
        require(marker == 22 && expected == 22 && private_value == 99,
                "child libc-poll TLS and globals");
        _exit(47);
    }
    library_compute(library_bytes, library_size);
    reap(library_child, 47);
    require(marker == 11 && expected == 11 && private_value == 61,
            "parent libc-poll TLS and globals");
    free(library_bytes);
    puts("fork poll: libc memchr timer and post-thread parent-child TLS pass");
#endif
    puts("::vm-test::pass");
#ifdef FORK_POLL_NATIVE_REFERENCE
    return 0;
#else
    for (;;) pause();
#endif
}
