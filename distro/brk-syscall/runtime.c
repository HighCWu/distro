// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Thread_local unsigned char tls_probe[8192];
static void *slots[2][64];

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: brk syscall: %s errno=%d\n", what, errno);
    exit(1);
}

static uintptr_t change_break(uintptr_t requested)
{
    return (uintptr_t)syscall(SYS_brk, (long)requested, 0L, 0L, 0L, 0L, 0L);
}

static uintptr_t current_break(void)
{
    uintptr_t value = change_break(0);
    require(value && value < (uintptr_t)-4095, "standard brk query");
    return value;
}

static void *allocate_slots(void *argument)
{
    size_t id = (uintptr_t)argument;
    tls_probe[0] = 0x20 + id;
    tls_probe[8191] = 0x30 + id;
    for (size_t i = 0; i < 64; i++) {
        void *pointer = sbrk(64);
        if (pointer == (void *)-1) return (void *)1;
        slots[id][i] = pointer;
        memset(pointer, 0x40 + id, 64);
    }
    return tls_probe[0] == 0x20 + id && tls_probe[8191] == 0x30 + id ? NULL : (void *)2;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    size_t page = sysconf(_SC_PAGESIZE);
    require(page && !(page & (page - 1)), "page size");
    uintptr_t before = current_break();
    require((uintptr_t)sbrk(0) == before, "libc and raw query share one break");
    errno = EDOM;
    require(change_break(before + 64) == before + 64 && errno == EDOM &&
            (uintptr_t)sbrk(0) == before + 64, "raw growth preserves errno and libc sees update");
    memset((void *)before, 0x17, 64);
    errno = 0;
    require(change_break(before) == before + 64 && sbrk(-1) == (void *)-1 && errno == ENOMEM,
            "existing monotonic arena refuses shrink without moving the break");
    puts("brk syscall: standard query, raw growth, errno and libc state coherence pass");

    struct rlimit as = {0}, data = {0}, restricted;
    require(!getrlimit(RLIMIT_AS, &as) && !getrlimit(RLIMIT_DATA, &data), "read limits");
    before = current_break();
    restricted = as;
    restricted.rlim_cur = (before + page - 1) & -(uintptr_t)page;
    require(!setrlimit(RLIMIT_AS, &restricted), "lower live address-space soft limit");
    errno = EDOM;
    require(change_break(before + page) == before && errno == EDOM,
            "AS refusal returns old break without changing errno");
    void *large = malloc(32 * 1024 * 1024);
    require(large == NULL && errno == ENOMEM && current_break() <= restricted.rlim_cur,
            "ordinary malloc growth is constrained after setrlimit");
    require(!setrlimit(RLIMIT_AS, &as), "restore AS limit");
    before = current_break();
    restricted = data;
    restricted.rlim_cur = 0;
    require(!setrlimit(RLIMIT_DATA, &restricted), "lower live data soft limit");
    errno = EDOM;
    require(change_break(before + 1) == before && errno == EDOM,
            "DATA refusal preserves raw break and errno");
    errno = 0;
    require(brk((void *)(before + 1)) == -1 && errno == ENOMEM && current_break() == before,
            "libc brk reports denied DATA growth");
    require(!setrlimit(RLIMIT_DATA, &data), "restore DATA limit");
    require((uintptr_t)sbrk(64) == before && current_break() == before + 64,
            "growth recovers after limits are restored");
    puts("brk syscall: live AS/DATA limits, malloc refusal and restored growth pass");

    unsigned char *mapping = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    require(mapping != MAP_FAILED, "mmap through the shared allocator");
    memset(mapping, 0x5a, 2 * page);
    tls_probe[0] = 0x11;
    tls_probe[8191] = 0x12;
    pthread_t threads[2];
    for (size_t id = 0; id < 2; id++)
        require(!pthread_create(&threads[id], NULL, allocate_slots, (void *)(uintptr_t)id), "thread creation");
    for (size_t id = 0; id < 2; id++) {
        void *result;
        require(!pthread_join(threads[id], &result) && !result, "thread allocation and large TLS");
    }
    for (size_t id = 0; id < 2; id++) {
        for (size_t i = 0; i < 64; i++) {
            unsigned char *pointer = slots[id][i];
            for (size_t n = 0; n < 64; n++) require(pointer[n] == 0x40 + id, "sbrk slot contents");
            for (size_t other = 0; other < 2; other++)
                for (size_t j = 0; j < 64; j++)
                    if (id != other || i != j)
                        require(slots[id][i] != slots[other][j], "concurrent libc increments never alias");
        }
    }
    require(tls_probe[0] == 0x11 && tls_probe[8191] == 0x12, "main TLS isolation");
    mapping = mremap(mapping, 2 * page, 4 * page, MREMAP_MAYMOVE);
    require(mapping != MAP_FAILED, "mremap after syscall-routed heap allocations");
    for (size_t i = 0; i < 4 * page; i++)
        require(mapping[i] == (i < 2 * page ? 0x5a : 0), "mapping payload and growth zeroing");
    require(!munmap(mapping, 4 * page), "mapping cleanup");
    puts("brk syscall: shared allocator threads, large TLS and mmap recovery pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
