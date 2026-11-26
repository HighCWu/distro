// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define ROOT "/cgroup-cpuacct"
#define LEAF ROOT "/worker"
enum { WORK_BATCH = 16384 };

static volatile uint64_t busy_sink = UINT64_C(0x123456789abcdef0);

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: cgroup cpuacct: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static void control(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t length = strlen(value);
    ssize_t count;
    do { count = write(fd, value, length); } while (count < 0 && errno == EINTR);
    require(count == (ssize_t)length && close(fd) == 0, "write complete cgroup control");
}

static void check_tasks(const char *path, int expected, int exclusive)
{
    FILE *file = fopen(path, "r");
    require(file != NULL, path);
    long tid;
    int found = 0;
    int result;
    while ((result = fscanf(file, "%ld", &tid)) == 1) {
        if (tid == (long)getpid()) {
            require(!found, "test process appears only once in cgroup tasks");
            found = 1;
        } else if (exclusive) {
            require(0, "leaf cgroup contains only the expected test process");
        }
    }
    require(result == EOF && !ferror(file) && fclose(file) == 0 && found == expected,
            "verify cgroup task membership");
}

static uint64_t read_usage(void)
{
    FILE *file = fopen(LEAF "/cpuacct.usage", "r");
    require(file != NULL, "open leaf cpuacct.usage");
    uint64_t usage = 0;
    require(fscanf(file, "%" SCNu64, &usage) == 1 && !ferror(file) && fclose(file) == 0,
            "read leaf cpuacct.usage");
    return usage;
}

static uint64_t monotonic_ns(void)
{
    struct timespec now;
    require(clock_gettime(CLOCK_MONOTONIC, &now) == 0, "read monotonic clock");
    return (uint64_t)now.tv_sec * UINT64_C(1000000000) + (uint64_t)now.tv_nsec;
}

static void burn_cpu(void)
{
    uint64_t value = busy_sink;
    for (uint32_t i = 0; i < WORK_BATCH; ++i) {
        value = (value ^ (value >> 11)) * UINT64_C(0x9e3779b97f4a7c15) + i;
    }
    busy_sink = value;
}

static uint64_t exercise_cpuacct(uint64_t initial)
{
    uint64_t previous = initial;
    const uint64_t deadline = monotonic_ns() + UINT64_C(3000000000);
    unsigned batches = 0;
    while (monotonic_ns() < deadline) {
        burn_cpu();
        batches++;
        const uint64_t current = read_usage();
        require(current >= previous, "cpuacct.usage is monotonic during CPU work");
        if (current > initial) return current;
        previous = current;
    }
    require(batches && previous > initial, "bounded busy loop raises leaf cpuacct.usage");
    return previous;
}

int main(void)
{
#ifndef __wasm__
    require(0, "run only in the isolated Linux/Wasm VM");
#endif
    require(getpid() == 1 && getuid() == 0 && geteuid() == 0, "isolated root test process");
    require(mkdir(ROOT, 0755) == 0 && mount("none", ROOT, "cgroup", 0, "cpuacct") == 0,
            "mount a cgroup v1 cpuacct hierarchy");
    require(mkdir(LEAF, 0755) == 0, "create cpuacct worker group");
    control(LEAF "/tasks", "0");
    check_tasks(LEAF "/tasks", 1, 1);
    check_tasks(ROOT "/tasks", 0, 0);

    const uint64_t before = read_usage();
    const uint64_t after = exercise_cpuacct(before);
    printf("cgroup cpuacct: busy work raised usage by %" PRIu64 " ns\n", after - before);
    control(ROOT "/tasks", "0");
    check_tasks(ROOT "/tasks", 1, 0);
    check_tasks(LEAF "/tasks", 0, 1);
    require(rmdir(LEAF) == 0, "remove the empty worker group");
    require(umount(ROOT) == 0 && rmdir(ROOT) == 0, "unmount and remove cpuacct hierarchy");
    puts("cgroup cpuacct: process migration, usage accounting and hierarchy cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
