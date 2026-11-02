// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in the isolated Linux/Wasm PID selection image"
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: clone PID selection: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static pid_t create(struct clone_args *args)
{
    return syscall(SYS_clone3, (long)(uintptr_t)args, (long)sizeof *args);
}

static void reject(struct clone_args *args, int error)
{
    errno = 0;
    pid_t child = create(args);
    if (!child) _exit(90);
    require(child == -1 && errno == error, "exact Linux selection error");
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
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected, "exact selected child exit");
    no_children();
}

static int descriptors(void)
{
    DIR *dir = opendir("/proc/self/fd");
    require(dir != NULL, "descriptor inventory");
    int count = 0;
    while (readdir(dir)) count++;
    require(closedir(dir) == 0, "descriptor inventory close");
    return count;
}

static void receive(int fd)
{
    struct pollfd item = { .fd = fd, .events = POLLIN };
    int result;
    do { result = poll(&item, 1, 5000); } while (result < 0 && errno == EINTR);
    char byte;
    require(result == 1 && (item.revents & POLLIN) && read(fd, &byte, 1) == 1 && byte == 'x', "child handoff");
}

static void send_byte(int fd)
{
    ssize_t result;
    do { result = write(fd, "x", 1); } while (result < 0 && errno == EINTR);
    require(result == 1, "handoff write");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc mountpoint");
    require(mount("none", "/proc", "proc", 0, NULL) == 0, "mount PID observations");
    FILE *limits = fopen("/proc/sys/kernel/pid_max", "r");
    int maximum = 0;
    require(limits && fscanf(limits, "%d", &maximum) == 1 && maximum > 10002, "selected IDs below kernel pid_max");
    require(fclose(limits) == 0, "close PID limit");
    int initial_fds = descriptors();
    int32_t ids[2] = {0, 10001};
    int pidfd = -1, parent_tid = -1, child_tid = -1;
    struct clone_args args = { .flags = CLONE_PIDFD, .exit_signal = SIGCHLD,
        .pidfd = (uintptr_t)&pidfd, .set_tid = (uintptr_t)ids, .set_tid_size = 1 };
    _Static_assert(sizeof args == 88, "Linux aligned u64 clone_args");
    reject(&args, EINVAL);
    ids[0] = -1;
    reject(&args, EINVAL);
    ids[0] = INT32_MAX;
    reject(&args, EINVAL);
    ids[0] = 10000;
    args.set_tid_size = 2;
    reject(&args, EINVAL); // Initial PID namespace cannot consume two levels.
    args.set_tid_size = 1;
    args.set_tid = UINT64_MAX;
    reject(&args, EFAULT);
    args.set_tid = (uintptr_t)ids;
    no_children();
    require(pidfd == -1 && descriptors() == initial_fds, "selection rejection leaves no output or fd leak");
    puts("clone PID selection: signed ranges, namespace depth and bad vector reject without side effects pass");

    int ready[2], release[2];
    require(pipe2(ready, O_CLOEXEC) == 0 && pipe2(release, O_CLOEXEC) == 0, "selected child pipes");
    args.flags |= CLONE_PARENT_SETTID | CLONE_CHILD_SETTID;
    args.parent_tid = (uintptr_t)&parent_tid;
    args.child_tid = (uintptr_t)&child_tid;
    pid_t child = create(&args);
    require(child >= 0, "select initial-namespace PID");
    if (!child) {
        require(getpid() == 10000 && syscall(SYS_gettid) == 10000 && child_tid == 10000 &&
                parent_tid == -1 && pidfd == -1, "selected child identity and independent outputs");
        require(close(ready[0]) == 0 && close(release[1]) == 0, "child pipe ownership");
        send_byte(ready[1]);
        receive(release[0]);
        require(close(ready[1]) == 0 && close(release[0]) == 0, "child pipe close");
        _exit(37);
    }
    require(child == 10000 && parent_tid == child && child_tid == -1 && pidfd >= 0,
            "parent sees selected PID and only parent stores");
    require(fcntl(pidfd, F_GETFD) & FD_CLOEXEC, "selected PIDFD is close-on-exec");
    require(close(ready[1]) == 0 && close(release[0]) == 0, "parent pipe ownership");
    receive(ready[0]);
    int collision_fd = -1;
    args.flags = CLONE_PIDFD;
    args.pidfd = (uintptr_t)&collision_fd;
    reject(&args, EEXIST);
    require(collision_fd == -1, "live PID collision does not publish another PIDFD");
    send_byte(release[1]);
    reap(child, 37);
    struct pollfd item = { .fd = pidfd, .events = POLLIN };
    require(poll(&item, 1, 0) == 1 && (item.revents & POLLIN), "selected child PIDFD readiness");
    require(close(pidfd) == 0 && close(ready[0]) == 0 && close(release[1]) == 0,
            "selected child descriptors close");
    require(descriptors() == initial_fds, "selected child fd recovery");
    puts("clone PID selection: exact PID/TID, PIDFD, live collision and single reap pass");

    ids[0] = 1; ids[1] = 10001;
    pidfd = -1;
    args.flags = CLONE_NEWPID | CLONE_PIDFD;
    args.pidfd = (uintptr_t)&pidfd;
    args.set_tid_size = 2;
    child = create(&args);
    require(child >= 0, "select nested and outer namespace PIDs");
    if (!child) {
        require(getpid() == 1 && syscall(SYS_gettid) == 1 && getppid() == 0,
                "innermost array entry selects namespace init");
        _exit(48);
    }
    require(child == 10001 && pidfd >= 0, "second entry selects parent-visible PID");
    reap(child, 48);
    require(close(pidfd) == 0, "nested selected PIDFD close");

    args.flags = 0;
    args.pidfd = 0;
    args.set_tid = 0;
    args.set_tid_size = 0;
    child = create(&args);
    require(child >= 0, "ordinary clone3 after PID selection");
    if (!child) _exit(50);
    reap(child, 50);

    child = fork();
    require(child >= 0, "fork after namespace selection");
    if (!child) {
        require(setuid(65534) == 0, "drop selection capability");
        ids[0] = 10002;
        args.flags = CLONE_PIDFD;
        args.pidfd = (uintptr_t)&pidfd;
        args.set_tid = (uintptr_t)ids;
        args.set_tid_size = 1;
        pidfd = -1;
        reject(&args, EPERM);
        require(pidfd == -1, "permission failure preserves output");
        no_children();
        pid_t later = fork();
        require(later >= 0, "unprivileged ordinary fork recovery");
        if (!later) _exit(12);
        reap(later, 12);
        _exit(49);
    }
    reap(child, 49);
    require(getuid() == 0 && descriptors() == initial_fds, "parent credentials and descriptors unchanged");
    require(umount("/proc") == 0 && rmdir("/proc") == 0, "PID observations cleanup");
    puts("clone PID selection: namespace ordering, EPERM, ordinary fork recovery and cleanup pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
