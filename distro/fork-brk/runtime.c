// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

enum {
    malloc_size = 32 * 1024 * 1024,
    parent_heap_size = 4096,
    wait_attempts = 3000,
};

static int active_resource = -1;
static const struct rlimit *active_original;

static long raw_brk(uintptr_t requested)
{
    return syscall(SYS_brk, (long)requested, 0L, 0L, 0L, 0L, 0L);
}

static int restore_parent_limit(void)
{
    const struct rlimit *original = active_original;
    if (!original)
        return 0;
    if (setrlimit(active_resource, original) == -1)
        return -1;
    active_resource = -1;
    active_original = NULL;
    return 0;
}

static _Noreturn void emergency_exit(void)
{
    static const char message[] =
        "fork brk: unable to restore resource limit; exiting without allocation\n";
    ssize_t written = write(STDERR_FILENO, message, sizeof(message) - 1);
    if (written < 0)
        _exit(1);
    _exit(1);
}

static _Noreturn void fail(const char *message)
{
    if (restore_parent_limit() == -1)
        emergency_exit();
    fprintf(stderr, "::vm-test::fail: fork brk: %s errno=%d\n", message, errno);
    fflush(stderr);
    exit(1);
}

static int wait_child_bounded(pid_t pid, int *status)
{
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 10 * 1000 * 1000 };
    for (int attempt = 0; attempt < wait_attempts; attempt++) {
        pid_t result = waitpid(pid, status, WNOHANG);
        if (result == pid)
            return 0;
        if (result == -1 && errno != EINTR)
            return -1;
        while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
        }
        delay.tv_sec = 0;
        delay.tv_nsec = 10 * 1000 * 1000;
    }
    errno = ETIMEDOUT;
    return 1;
}

static void terminate_and_reap(pid_t pid)
{
    int status;
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 10 * 1000 * 1000 };
    (void)kill(pid, SIGKILL);
    for (int attempt = 0; attempt < 200; attempt++) {
        pid_t result = waitpid(pid, &status, WNOHANG);
        if (result == pid || (result == -1 && errno == ECHILD))
            return;
        if (result == -1 && errno != EINTR)
            return;
        while (nanosleep(&delay, &delay) == -1 && errno == EINTR) {
        }
        delay.tv_sec = 0;
        delay.tv_nsec = 10 * 1000 * 1000;
    }
}

static int child_restricted_round(int resource, const struct rlimit *original,
                                  rlim_t restricted_soft, size_t page,
                                  volatile unsigned char *parent_heap)
{
    struct rlimit inherited;
    void *libc_break;
    uintptr_t break_value;
    uintptr_t raw_value;
    long raw_result;
    void *growth;
    void *large;

    if (getrlimit(resource, &inherited) == -1 ||
        inherited.rlim_cur != restricted_soft ||
        inherited.rlim_max != original->rlim_max)
        return 11;

    libc_break = sbrk(0);
    if (libc_break == (void *)-1)
        return 12;
    break_value = (uintptr_t)libc_break;
    errno = EDOM;
    raw_value = (uintptr_t)raw_brk(0);
    if (raw_value != break_value || errno != EDOM)
        return 13;

    if (break_value > UINTPTR_MAX - page)
        return 14;
    errno = ERANGE;
    raw_result = raw_brk(break_value + page);
    if ((uintptr_t)raw_result != break_value || errno != ERANGE)
        return 15;

    errno = 0;
    growth = sbrk((intptr_t)page);
    if (growth != (void *)-1 || errno != ENOMEM ||
        (uintptr_t)sbrk(0) != break_value)
        return 16;

    errno = 0;
    large = malloc(malloc_size);
    if (large != NULL || errno != ENOMEM)
        return 17;

    if (setrlimit(resource, original) == -1)
        return 18;
    if (getrlimit(resource, &inherited) == -1 ||
        inherited.rlim_cur != original->rlim_cur ||
        inherited.rlim_max != original->rlim_max)
        return 19;

    libc_break = sbrk(0);
    if (libc_break == (void *)-1 ||
        (uintptr_t)libc_break > UINTPTR_MAX - page)
        return 20;
    growth = sbrk((intptr_t)page);
    if (growth == (void *)-1 || growth != libc_break ||
        (uintptr_t)sbrk(0) != (uintptr_t)libc_break + page)
        return 21;
    ((volatile unsigned char *)growth)[0] = 0x3c;
    ((volatile unsigned char *)growth)[page - 1] = 0xc3;

    errno = 0;
    large = malloc(malloc_size);
    if (large == NULL)
        return 22;
    ((volatile unsigned char *)large)[0] = 0x5a;
    ((volatile unsigned char *)large)[malloc_size - 1] = 0xa5;
    if (((volatile unsigned char *)large)[0] != 0x5a ||
        ((volatile unsigned char *)large)[malloc_size - 1] != 0xa5)
        return 23;

    parent_heap[0] = 0xe1;
    parent_heap[parent_heap_size - 1] = 0x1e;
    return 0;
}

static const char *child_error(int code)
{
    switch (code) {
    case 11: return "child did not inherit the restricted soft limit";
    case 12: return "child sbrk break query failed";
    case 13: return "raw brk query differed from sbrk or changed errno";
    case 14: return "child break address overflow";
    case 15: return "raw brk growth was not denied without changing errno";
    case 16: return "libc sbrk growth did not fail atomically with ENOMEM";
    case 17: return "32 MiB malloc was not denied with ENOMEM";
    case 18: return "child could not restore its resource limit";
    case 19: return "child did not observe its restored resource limit";
    case 20: return "child break query after limit restoration failed";
    case 21: return "libc sbrk growth did not recover after restoration";
    case 22: return "32 MiB malloc did not recover after restoration";
    case 23: return "child malloc sentinels did not persist";
    default: return "child returned an unexpected status";
    }
}

static void run_limit_round(int resource, const struct rlimit *original,
                            rlim_t restricted_soft, size_t page,
                            volatile unsigned char *parent_heap)
{
    struct rlimit restricted = *original;
    struct rlimit observed;
    pid_t child;
    int status;
    uintptr_t parent_break_after_fork;
    uintptr_t parent_break_after_child;

    restricted.rlim_cur = restricted_soft;
    /* Linux permits mmap while RLIMIT_DATA is exactly zero as a Valgrind
       workaround; one byte still rejects brk and mmap growth on both targets. */
    if (setrlimit(resource, &restricted) == -1)
        fail("setting the resource soft limit");
    active_resource = resource;
    active_original = original;

    child = fork();
    if (child == -1)
        fail("fork with a restricted resource soft limit");
    if (child == 0)
        _exit(child_restricted_round(resource, original, restricted_soft,
                                     page, parent_heap));

    if (restore_parent_limit() == -1) {
        terminate_and_reap(child);
        emergency_exit();
    }
    parent_break_after_fork = (uintptr_t)sbrk(0);
    if (parent_break_after_fork == (uintptr_t)-1)
        fail("reading parent break after fork");

    int waited = wait_child_bounded(child, &status);
    if (waited != 0) {
        if (waited == 1)
            terminate_and_reap(child);
        fail(waited == 1 ? "child wait timed out" : "waiting for child");
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        char message[96];
        int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        (void)snprintf(message, sizeof(message), "%s (child status %d)",
                       child_error(code), code);
        fail(message);
    }

    if (waitpid(child, &status, WNOHANG) != -1 || errno != ECHILD)
        fail("child was not reaped exactly once");
    if (getrlimit(resource, &observed) == -1 ||
        observed.rlim_cur != original->rlim_cur ||
        observed.rlim_max != original->rlim_max)
        fail("child changed the parent's resource limit");
    parent_break_after_child = (uintptr_t)sbrk(0);
    if (parent_break_after_child != parent_break_after_fork)
        fail("child allocator growth changed the parent break");
    if (parent_heap[0] != 0x69 || parent_heap[parent_heap_size - 1] != 0x96)
        fail("child allocator writes changed the parent heap");
}

static void run_recovery(void)
{
    long page_value = sysconf(_SC_PAGESIZE);
    if (page_value <= 0)
        fail("querying page size");
    size_t page = (size_t)page_value;
    unsigned char *mapping = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED)
        fail("mmap after limit-restricted fork");
    memset(mapping, 0x5a, 2 * page);
    unsigned char *resized = mremap(mapping, 2 * page, 4 * page, MREMAP_MAYMOVE);
    if (resized == MAP_FAILED) {
        (void)munmap(mapping, 2 * page);
        fail("mremap after limit-restricted fork");
    }
    for (size_t index = 0; index < 4 * page; index++) {
        unsigned char expected = index < 2 * page ? 0x5a : 0;
        if (resized[index] != expected) {
            (void)munmap(resized, 4 * page);
            fail("mremap data preservation and zero-fill");
        }
    }
    if (munmap(resized, 4 * page) == -1)
        fail("munmap after limit-restricted fork");

    pid_t child = fork();
    if (child == -1)
        fail("recovery fork");
    if (child == 0)
        _exit(getpid() != getppid() ? 0 : 1);
    int status;
    int waited = wait_child_bounded(child, &status);
    if (waited != 0) {
        if (waited == 1)
            terminate_and_reap(child);
        fail(waited == 1 ? "recovery child wait timed out" : "waiting for recovery child");
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
        fail("fork and wait after allocator recovery");
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);

    long page_value = sysconf(_SC_PAGESIZE);
    if (page_value <= 0)
        fail("querying page size");
    size_t page = (size_t)page_value;

    struct rlimit original_as;
    struct rlimit original_data;
    if (getrlimit(RLIMIT_AS, &original_as) == -1 ||
        getrlimit(RLIMIT_DATA, &original_data) == -1)
        fail("saving original resource limits");

    volatile unsigned char *parent_heap = malloc(parent_heap_size);
    if (parent_heap == NULL)
        fail("allocating parent heap sentinels");
    parent_heap[0] = 0x69;
    parent_heap[parent_heap_size - 1] = 0x96;
    void *warmup = malloc(64);
    if (warmup == NULL)
        fail("warming the parent allocator");
    free(warmup);

    run_limit_round(RLIMIT_AS, &original_as, 0, page, parent_heap);
    puts("fork brk: RLIMIT_AS fork inheritance and allocator isolation pass");
    run_limit_round(RLIMIT_DATA, &original_data, 1, page, parent_heap);
    puts("fork brk: RLIMIT_DATA fork inheritance and allocator isolation pass");
    run_recovery();
    puts("fork brk: mmap mremap zero-fill and fork recovery pass");

    free((void *)parent_heap);
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;)
        pause();
#else
    return 0;
#endif
}

