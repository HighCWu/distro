// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in the isolated Linux/Wasm cgroup test image"
#endif
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <poll.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define ROOT "/cgroup-pids"
#define LEAF ROOT "/work"

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: cgroup pids: %s (errno=%d)\n", what, errno);
        exit(1);
    }
}

static void control(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t length = strlen(value);
    ssize_t count;
    do { count = write(fd, value, length); } while (count < 0 && errno == EINTR);
    require(count == (ssize_t)length, "complete cgroup control write");
    require(close(fd) == 0, "close cgroup control");
}

static void contents(const char *path, char *buffer, size_t capacity)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t used = 0;
    for (;;) {
        require(used + 1 < capacity, "bounded cgroup read");
        ssize_t count = read(fd, buffer + used, capacity - used - 1);
        if (count < 0 && errno == EINTR) continue;
        require(count >= 0, "read cgroup file");
        if (!count) break;
        used += (size_t)count;
    }
    buffer[used] = 0;
    require(close(fd) == 0, "close cgroup read");
}

static unsigned long long number(const char *text)
{
    char *end;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    require(text[0] >= '0' && text[0] <= '9' && end != text && !errno &&
            (!*end || (*end == '\n' && !end[1])), "cgroup integer");
    return value;
}

static unsigned long long current(void)
{
    char buffer[64];
    contents(LEAF "/pids.current", buffer, sizeof(buffer));
    return number(buffer);
}

static unsigned long long events(void)
{
    char buffer[128];
    contents(LEAF "/pids.events", buffer, sizeof(buffer));
    require(!strncmp(buffer, "max ", 4), "pids.events max counter");
    return number(buffer + 4);
}

static void denied(void)
{
    errno = 0;
    pid_t child = fork();
    if (!child) _exit(90);
    require(child == -1 && errno == EAGAIN, "ordinary fork limit returns EAGAIN");
}

static void no_children(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD,
            "no published or unreaped child");
}

static void wait_child(pid_t child, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
            "wait and child exit status");
}

static void send_byte(int fd)
{
    ssize_t count;
    do { count = write(fd, "x", 1); } while (count < 0 && errno == EINTR);
    require(count == 1, "pipe handoff write");
}

static void receive_byte(int fd)
{
    struct pollfd item = { .fd = fd, .events = POLLIN };
    int ready;
    do { ready = poll(&item, 1, 5000); } while (ready < 0 && errno == EINTR);
    require(ready == 1 && (item.revents & POLLIN), "bounded child handoff");
    char byte;
    ssize_t count;
    do { count = read(fd, &byte, 1); } while (count < 0 && errno == EINTR);
    require(count == 1 && byte == 'x', "pipe handoff read");
}

static void clone_into_group(void)
{
    int group = open(LEAF, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(group >= 0, "open target cgroup");
    int pidfd = -1;
    struct clone_args args = {
        .flags = CLONE_INTO_CGROUP | CLONE_PIDFD,
        .exit_signal = SIGCHLD,
        .pidfd = (uintptr_t)&pidfd,
        .cgroup = (unsigned)group,
    };
    DIR *inventory = opendir("/proc/self/fd");
    require(inventory != NULL, "initial descriptor inventory");
    int initial_fds = 0;
    while (readdir(inventory)) initial_fds++;
    require(closedir(inventory) == 0, "initial inventory cleanup");
    errno = 0;
    require(syscall(SYS_clone3, (long)(uintptr_t)&args, 80L) == -1 && errno == EINVAL,
            "INTO_CGROUP requires VER2 size");
    args.cgroup = UINT64_C(1) << 32;
    errno = 0;
    require(syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args) == -1 && errno == EINVAL,
            "full-width fd cannot silently truncate");
    args.cgroup = 0x7fffffff;
    errno = 0;
    require(syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args) == -1 && errno == EBADF,
            "invalid cgroup descriptor rejected by Linux");
    args.cgroup = (unsigned)group;
    control(LEAF "/pids.max", "0");
    errno = 0;
    require(syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args) == -1 && errno == EAGAIN,
            "target PIDs controller refuses birth");
    require(pidfd == -1 && current() == 0, "failed creation leaves output and target unchanged");
    inventory = opendir("/proc/self/fd");
    require(inventory != NULL, "rollback descriptor inventory");
    int final_fds = 0;
    while (readdir(inventory)) final_fds++;
    require(closedir(inventory) == 0 && final_fds == initial_fds,
            "failed clone3 leaves no leaked descriptors");
    no_children();
    puts("clone3 cgroup: size, descriptor and PIDs rejection leave no child or PIDFD pass");

    control(LEAF "/pids.max", "1");
    char parent_group[256];
    contents("/proc/self/cgroup", parent_group, sizeof parent_group);
    int ready[2], release[2];
    require(pipe2(ready, O_CLOEXEC) == 0 && pipe2(release, O_CLOEXEC) == 0, "birth handshake pipes");
    pid_t child = syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args);
    require(child >= 0, "create directly in target cgroup");
    if (!child) {
        require(pidfd == -1, "parent PIDFD output not copied into child snapshot");
        require(close(ready[0]) == 0 && close(release[1]) == 0, "born child endpoints");
        char membership[256];
        contents("/proc/self/cgroup", membership, sizeof membership);
        require(!strcmp(membership, "0::/work\n") && current() == 1,
                "first user observation is already in target group");
        send_byte(ready[1]);
        receive_byte(release[0]);
        require(close(ready[1]) == 0 && close(release[0]) == 0, "born child cleanup");
        _exit(43);
    }
    require(close(ready[1]) == 0 && close(release[0]) == 0, "birth parent endpoints");
    receive_byte(ready[0]);
    require(pidfd >= 0 && (fcntl(pidfd, F_GETFD) & FD_CLOEXEC), "kernel-published close-on-exec PIDFD");
    struct pollfd item = { .fd = pidfd, .events = POLLIN };
    require(poll(&item, 1, 0) == 0, "live target child PIDFD not ready");
    char membership[256], expected[64];
    contents("/proc/self/cgroup", membership, sizeof membership);
    require(!strcmp(membership, parent_group), "parent membership unchanged");
    snprintf(expected, sizeof expected, "%ld\n", (long)child);
    contents(LEAF "/cgroup.procs", membership, sizeof membership);
    require(!strcmp(membership, expected) && current() == 1, "target contains only new child");
    send_byte(release[1]);
    wait_child(child, 43);
    require(poll(&item, 1, 0) == 1 && (item.revents & POLLIN), "reaped target PIDFD ready");
    require(close(pidfd) == 0 && close(ready[0]) == 0 && close(release[1]) == 0,
            "birth descriptors close");
    require(current() == 0, "target child charge released");
    no_children();
    puts("clone3 cgroup: birth membership, parent isolation, PIDFD and reap pass");

    child = fork();
    require(child >= 0, "ordinary fork after cgroup clone");
    if (!child) {
        contents("/proc/self/cgroup", membership, sizeof membership);
        require(!strcmp(membership, parent_group), "ordinary child inherits original group");
        _exit(44);
    }
    wait_child(child, 44);
    require(current() == 0 && close(group) == 0, "no stale cgroup option or descriptor");
    control(LEAF "/pids.max", "max");
    no_children();
    puts("clone3 cgroup: later ordinary fork and target accounting recovery pass");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages across fork");
    require(mkdir(ROOT, 0755) == 0, "mountpoint");
    require(mount("none", ROOT, "cgroup2", 0, NULL) == 0, "mount standard cgroup v2");
    char buffer[256];
    contents(ROOT "/cgroup.controllers", buffer, sizeof(buffer));
    int found = 0;
    for (char *token = strtok(buffer, " \n"); token; token = strtok(NULL, " \n"))
        if (!strcmp(token, "pids")) found = 1;
    require(found, "PIDs controller available");
    control(ROOT "/cgroup.subtree_control", "+pids");
    require(mkdir(LEAF, 0755) == 0, "create child cgroup");
    clone_into_group();
    control(LEAF "/cgroup.procs", "0");
    require(current() == 1, "caller migrated alone");
    contents(LEAF "/pids.max", buffer, sizeof(buffer));
    require(!strcmp(buffer, "max\n"), "default unlimited group");
    control(LEAF "/pids.max", "1");
    unsigned long long before = events();
    denied();
    require(current() == 1 && events() == before + 1, "limit rollback and event");
    no_children();
    puts("cgroup pids: standard hierarchy, membership and max admission rollback pass");

    control(LEAF "/pids.max", "2");
    int ready[2], release[2];
    require(pipe2(ready, O_CLOEXEC) == 0 && pipe2(release, O_CLOEXEC) == 0, "child pipes");
    pid_t child = fork();
    require(child >= 0, "admitted ordinary fork");
    if (!child) {
        require(close(ready[0]) == 0 && close(release[1]) == 0, "child unused endpoints");
        require(current() == 2, "child inherits group accounting");
        denied();
        require(current() == 2 && events() == before + 2, "inherited limit rollback");
        no_children();
        send_byte(ready[1]);
        receive_byte(release[0]);
        require(close(ready[1]) == 0 && close(release[0]) == 0, "child pipe cleanup");
        _exit(23);
    }
    require(close(ready[1]) == 0 && close(release[0]) == 0, "parent unused endpoints");
    receive_byte(ready[0]);
    require(current() == 2 && events() == before + 2, "live child accounted in same limit");
    send_byte(release[1]);
    wait_child(child, 23);
    require(close(ready[0]) == 0 && close(release[1]) == 0, "parent pipe cleanup");
    require(current() == 1, "reaped task uncharged");
    no_children();
    puts("cgroup pids: inherited child limit, live accounting and wait cleanup pass");

    control(LEAF "/pids.max", "max");
    child = fork();
    require(child >= 0, "fork recovery after unlimited reset");
    if (!child) _exit(37);
    wait_child(child, 37);
    require(current() == 1, "recovery leaves only parent");
    no_children();
    control(ROOT "/cgroup.procs", "0");
    require(current() == 0, "migration removes last task");
    require(rmdir(LEAF) == 0, "remove empty leaf");
    control(ROOT "/cgroup.subtree_control", "-pids");
    require(umount(ROOT) == 0 && rmdir(ROOT) == 0, "hierarchy teardown");
    puts("cgroup pids: unlimited recovery, migration and hierarchy teardown pass");
    return 0;
}
