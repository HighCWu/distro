// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <linux/futex.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __wasm__
__attribute__((import_module("linux"), import_name("syscall")))
extern long raw(long, long, long, long, long, long, long);
#else
static long raw(long n, long a, long b, long c, long d, long e, long f)
{
    long result = syscall(n, a, b, c, d, e, f);
    return result < 0 ? -errno : result;
}
#endif
enum { direct_exit, killed_waiter, pending, bad_next, bad_head };
/* Outside Linux's ERR_PTR range: get_robust_list propagates values in that
 * range as errors. The address is still outside bounded user linear memory. */
#define BAD_LIST_ADDRESS ((void *)(uintptr_t)-8192)
struct node { struct robust_list link; _Atomic uint32_t owner; };
struct state {
    struct robust_list_head head;
    struct node node;
    int mode, ready[2], release[2];
};
static atomic_int waiter_tid;
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: kernel robust: %s errno=%d\n", what, errno);
    exit(1);
}
static _Noreturn void raw_exit(int status)
{
    raw(SYS_exit, status, 0, 0, 0, 0, 0);
    __builtin_trap();
}
static int child(void *pointer)
{
    /* No pthread return/exit wrapper or userspace robust-list walk. The
     * shared-VM callback uses no libc allocation, native TLS or errno. */
    struct state *s = pointer;
    struct robust_list_head *head = s->mode == bad_head ? BAD_LIST_ADDRESS : &s->head;
    long tid = raw(SYS_gettid, 0, 0, 0, 0, 0, 0);
    if (raw(SYS_set_robust_list, (long)head, sizeof(*head)-1, 0, 0, 0, 0) != -EINVAL)
        raw_exit(101);
#ifndef ROBUST_SKIP_REGISTRATION
    if (raw(SYS_set_robust_list, (long)head, sizeof(*head), 0, 0, 0, 0)) raw_exit(102);
#endif
    atomic_store(&s->node.owner, (uint32_t)tid | FUTEX_WAITERS);
    raw(SYS_close, s->ready[0], 0, 0, 0, 0, 0);
    raw(SYS_close, s->release[1], 0, 0, 0, 0, 0);
    char token = 'R';
    if (raw(SYS_write, s->ready[1], (long)&token, 1, 0, 0, 0) != 1) raw_exit(103);
    if (raw(SYS_read, s->release[0], (long)&token, 1, 0, 0, 0) != 1) raw_exit(104);
    raw_exit(37);
}
static void *waiter(void *pointer)
{
    struct node *node = pointer;
    uint32_t owner = atomic_load(&node->owner);
    atomic_store(&waiter_tid, (int)raw(SYS_gettid, 0, 0, 0, 0, 0, 0));
    long long timeout[2] = { 5, 0 }; /* Linux time64 layout, including wasm32. */
#if __SIZEOF_LONG__ == 4
    const long number = SYS_futex_time64;
#else
    const long number = SYS_futex;
#endif
    long result = raw(number, (long)&node->owner, FUTEX_WAIT, owner, (long)timeout, 0, 0);
    return (void *)(uintptr_t)(result != 0);
}
static void wait_sleeping(void)
{
    struct timespec begin, now, delay = { .tv_nsec = 1000000 };
    require(clock_gettime(CLOCK_MONOTONIC, &begin) == 0, "waiter deadline");
    for (;;) {
        int tid = atomic_load(&waiter_tid);
        if (tid) {
            char path[96], line[256];
            snprintf(path, sizeof path, "/proc/self/task/%d/status", tid);
            FILE *file = fopen(path, "r");
            require(file != NULL, "observe waiter state");
            int sleeping = 0;
            while (fgets(line, sizeof line, file))
                if (!strncmp(line, "State:\tS", 8)) sleeping = 1;
            require(!ferror(file) && fclose(file) == 0, "close waiter state");
            if (sleeping) return;
        }
        require(clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec - begin.tv_sec < 4,
                "waiter must enter futex sleep before owner is killed");
        require(nanosleep(&delay, NULL) == 0, "yield for futex wait");
    }
}
static void scenario(int mode)
{
    _Static_assert(sizeof(struct robust_list_head) == 3 * sizeof(long), "native Linux robust-list ABI");
    struct state state = { .mode = mode };
    state.head.list.next = mode == pending ? &state.head.list : &state.node.link;
    state.head.futex_offset = offsetof(struct node, owner) - offsetof(struct node, link);
    state.head.list_op_pending = mode == pending ? &state.node.link : NULL;
    state.node.link.next = mode == bad_next ? BAD_LIST_ADDRESS : &state.head.list;
    require(pipe(state.ready) == 0 && pipe(state.release) == 0, "control pipes");
    size_t size = 1024 * 1024;
    void *stack = malloc(size);
    require(stack != NULL, "callback C stack");
    pid_t pid = clone(child, (char *)stack + size, CLONE_VM | SIGCHLD, &state);
    require(pid > 0, "single-thread callback clone with shared mm");
    require(close(state.ready[1]) == 0 && close(state.release[0]) == 0, "parent pipe ownership");
    char token;
    require(read(state.ready[0], &token, 1) == 1 && token == 'R', "registered owner ready");
    uint32_t original = atomic_load(&state.node.owner);
    require((original & FUTEX_TID_MASK) == (uint32_t)pid, "kernel TID owns word");
    struct robust_list_head *registered = NULL;
    size_t length = 0;
    long query = raw(SYS_get_robust_list, pid, (long)&registered, (long)&length, 0, 0, 0);
    if (query || length != sizeof state.head)
        fprintf(stderr, "kernel robust: registration mode=%d raw=%ld length=%zu expected=%zu\n",
                mode, query, length, sizeof state.head);
    require(query == 0 && length == sizeof state.head, "query actual child robust registration");
#ifndef ROBUST_SKIP_REGISTRATION
    require(registered == (mode == bad_head ? BAD_LIST_ADDRESS : &state.head), "registered list identity");
#endif
    pthread_t thread;
    if (mode == killed_waiter) {
        atomic_store(&waiter_tid, 0);
        require(pthread_create(&thread, NULL, waiter, &state.node) == 0, "create blocked robust waiter");
        wait_sleeping();
        require(kill(pid, SIGKILL) == 0, "kill owner without userspace cleanup");
    } else {
        token = 'X';
        require(write(state.release[1], &token, 1) == 1, "release raw syscall exit");
    }
    int status;
    require(waitpid(pid, &status, 0) == pid && (mode == killed_waiter ?
            WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL :
            WIFEXITED(status) && WEXITSTATUS(status) == 37), "exact owner termination");
    if (mode == killed_waiter) {
        void *result = (void *)1;
        require(pthread_join(thread, &result) == 0 && result == NULL, "kernel death cleanup wakes queued waiter");
    }
    uint32_t owner = atomic_load(&state.node.owner);
    require(mode == bad_head ? owner == original :
            owner == (FUTEX_OWNER_DIED | FUTEX_WAITERS), "kernel-owned owner-death transition");
    errno = 0;
    require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single child reaping");
    atomic_store(&state.node.owner, 0);
    require(raw(SYS_futex, (long)&state.node.owner, FUTEX_WAKE, 1, 0, 0, 0) == 0, "no abandoned waiters");
    require(close(state.ready[0]) == 0 && close(state.release[1]) == 0, "close control pipes");
    free(stack);
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
#ifdef __wasm__
    require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc mountpoint");
    require(mount("proc", "/proc", "proc", 0, NULL) == 0, "mount proc fixture");
#endif
    scenario(direct_exit);
    puts("kernel robust: raw syscall exit performs kernel list owner-death cleanup pass");
    scenario(killed_waiter);
    puts("kernel robust: SIGKILL owner death wakes an already sleeping futex waiter pass");
    scenario(pending);
    scenario(bad_next);
    scenario(bad_head);
    scenario(direct_exit);
#ifdef __wasm__
    require(umount("/proc") == 0, "release proc fixture");
#endif
    puts("kernel robust: pending entry, malformed list bounds and later valid exit recover pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
