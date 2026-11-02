// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "This workload changes only namespaces in the isolated Wasm machine"
#endif
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <sched.h>
#include <signal.h>
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

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: clone timens: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static int nsfd(const char *path)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open time namespace");
    return fd;
}

static int same(int first, int second)
{
    struct stat a, b;
    require(fstat(first, &a) == 0 && fstat(second, &b) == 0, "namespace stat");
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

static void identity(int original, int distinct)
{
    int active = nsfd("/proc/self/ns/time");
    int children = nsfd("/proc/self/ns/time_for_children");
    require(same(active, original) == !distinct && same(active, children),
            "active and future-child namespace identity");
    require(close(active) == 0 && close(children) == 0, "close namespace observations");
}

static void no_children(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "no unreaped child");
}

static void reap(pid_t child, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
            "actual child exit and single reap");
    no_children();
}

static pid_t create(int *pidfd, int *parent_tid)
{
    struct clone_args args = {
        .flags = CLONE_NEWTIME | CLONE_CLEAR_SIGHAND | CLONE_PIDFD | CLONE_PARENT_SETTID,
        .pidfd = (uintptr_t)pidfd, .parent_tid = (uintptr_t)parent_tid,
        .exit_signal = SIGCHLD,
    };
    _Static_assert(sizeof args == 88, "Linux aligned u64 clone_args");
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args);
}

static int64_t clock_ns(clockid_t clock)
{
    struct timespec now;
    require(clock_gettime(clock, &now) == 0, "namespace clock read");
    return (int64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static void offsets(int original)
{
    require(unshare(CLONE_NEWTIME) == 0, "prepare time namespace for children");
    int prepared = nsfd("/proc/self/ns/time_for_children");
    int active = nsfd("/proc/self/ns/time");
    require(!same(prepared, original) && same(active, original), "unshare leaves caller clock unchanged");
    require(close(active) == 0, "close unchanged namespace");
    int fd = open("/proc/self/timens_offsets", O_WRONLY | O_CLOEXEC);
    const char settings[] = "monotonic 120 0\nboottime 180 0\n";
    require(fd >= 0 && write(fd, settings, sizeof settings - 1) == sizeof settings - 1 &&
            close(fd) == 0, "configure original Linux time offsets");
    int64_t mono = clock_ns(CLOCK_MONOTONIC), boot = clock_ns(CLOCK_BOOTTIME);
    int pidfd = -1, parent_tid = -1;
    pid_t child = create(&pidfd, &parent_tid);
    require(child >= 0, "clone3 copies configured offsets into a fresh namespace");
    if (!child) {
        identity(original, 1);
        active = nsfd("/proc/self/ns/time");
        require(!same(active, prepared) && close(active) == 0, "clone3 creates another namespace");
        int64_t delta = clock_ns(CLOCK_MONOTONIC) - mono;
        require(delta >= INT64_C(120000000000) && delta < INT64_C(180000000000),
                "monotonic offset applied");
        delta = clock_ns(CLOCK_BOOTTIME) - boot;
        require(delta >= INT64_C(180000000000) && delta < INT64_C(240000000000),
                "boottime offset applied independently");
        int64_t deadline = clock_ns(CLOCK_MONOTONIC) + 10000000;
        struct timespec until = { deadline / 1000000000, deadline % 1000000000 };
        int64_t raw = clock_ns(CLOCK_MONOTONIC_RAW);
        int result;
        do { result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &until, NULL); }
        while (result == EINTR);
        require(result == 0 && clock_ns(CLOCK_MONOTONIC) >= deadline &&
                clock_ns(CLOCK_MONOTONIC_RAW) - raw < INT64_C(10000000000),
                "absolute namespace deadline translated to host clock");
        _exit(41);
    }
    require(parent_tid == child && pidfd >= 0, "offset child TID and PIDFD");
    reap(child, 41);
    require(close(pidfd) == 0 && setns(original, CLONE_NEWTIME) == 0 && close(prepared) == 0,
            "restore future-child namespace and descriptors");
    identity(original, 0);
    require(clock_ns(CLOCK_MONOTONIC) - mono < INT64_C(60000000000), "parent clock did not acquire offset");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc mountpoint");
    require(mount("none", "/proc", "proc", 0, NULL) == 0, "mount process namespace observations");
    int original = nsfd("/proc/self/ns/time");
    identity(original, 0);
    int pidfd = -1, parent_tid = -1;
    pid_t child = create(&pidfd, &parent_tid);
    require(child >= 0, "native clone3 NEWTIME");
    if (!child) { identity(original, 1); _exit(37); }
    int flags = fcntl(pidfd, F_GETFD);
    require(parent_tid == child && flags >= 0 && (flags & FD_CLOEXEC), "kernel TID and atomic PIDFD");
    identity(original, 0);
    reap(child, 37);
    require(close(pidfd) == 0, "close first PIDFD");
    puts("clone timens: native clone3 namespace identity, PIDFD, TID and parent isolation pass");

    offsets(original);
    puts("clone timens: independent monotonic and boottime offsets and absolute timer pass");

    child = fork();
    require(child >= 0, "permission-check child");
    if (!child) {
        require(setgid(65534) == 0 && setuid(65534) == 0, "drop namespace administrator");
        pidfd = parent_tid = -1;
        errno = 0;
        pid_t denied = create(&pidfd, &parent_tid);
        if (!denied) _exit(95);
        require(denied == -1 && errno == EPERM && pidfd == -1 && parent_tid == -1,
                "Linux permission refusal leaves output and process state unchanged");
        no_children();
        pid_t later = fork();
        require(later >= 0, "ordinary fork after permission refusal");
        if (!later) _exit(43);
        reap(later, 43);
        _exit(47);
    }
    reap(child, 47);
    identity(original, 0);
    require(close(original) == 0 && umount("/proc") == 0 && rmdir("/proc") == 0,
            "namespace handles and proc mount cleanup");
    puts("clone timens: kernel EPERM rollback, later fork and namespace cleanup pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
