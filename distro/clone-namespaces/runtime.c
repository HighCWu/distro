// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/msg.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int private_word = 17;
static int flags_first;

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: clone namespaces: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static pid_t create(uint64_t flags, int *pidfd)
{
    if (flags_first) {
        uint64_t legacy_flags = flags | SIGCHLD;
#if __SIZEOF_LONG__ == 8
        legacy_flags |= UINT64_C(1) << 40; /* Legacy Linux ignores upper flag bits. */
#endif
        return syscall(SYS_clone, (long)legacy_flags, 0L,
                       pidfd ? (long)(uintptr_t)pidfd : -1L, -1L, -1L, 999L);
    }
    struct clone_args args = { .flags = flags, .exit_signal = SIGCHLD,
        .pidfd = pidfd ? (uintptr_t)pidfd : 0 };
    _Static_assert(sizeof(struct clone_args) == 88, "Linux clone_args fixed u64 fields");
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof(args));
}

static void reap(pid_t child, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
            "child status and reap");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single child reap");
}

static void no_children(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD,
            "rejected request leaves no child");
}

static void run(int legacy)
{
    flags_first = legacy;
    const char *api = legacy ? "clone" : "clone3";
    struct utsname original;
    require(uname(&original) == 0, "parent UTS identity");
    int queue = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
    require(queue >= 0, "parent IPC object");
    int pidfd = -1;
    pid_t child = create(CLONE_NEWUTS | CLONE_NEWIPC | CLONE_PIDFD, &pidfd);
    require(child >= 0, "standard clone3 UTS/IPC and atomic PIDFD");
    if (!child) {
        require(pidfd == -1, "PIDFD is written only into parent memory");
        require(sethostname("linux-wasm-child", 16) == 0, "child namespace hostname");
        struct utsname changed;
        require(uname(&changed) == 0 && !strcmp(changed.nodename, "linux-wasm-child"),
                "child UTS change visible locally");
        struct msqid_ds state;
        errno = 0;
        require(msgctl(queue, IPC_STAT, &state) == -1 && errno == EINVAL,
                "new IPC namespace cannot access parent queue");
        int own = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
        require(own >= 0 && msgctl(own, IPC_RMID, NULL) == 0, "child IPC create and cleanup");
        private_word = 99;
        _exit(23);
    }
    int descriptor_flags = fcntl(pidfd, F_GETFD);
    require(pidfd >= 0 && descriptor_flags >= 0 && (descriptor_flags & FD_CLOEXEC), "kernel-created PIDFD");
    reap(child, 23);
    struct pollfd ready = { .fd = pidfd, .events = POLLIN };
    require(poll(&ready, 1, 1000) == 1 && (ready.revents & POLLIN), "namespaced child PIDFD readiness");
    require(close(pidfd) == 0, "PIDFD cleanup");
    struct utsname retained;
    struct msqid_ds state;
    require(uname(&retained) == 0 && !strcmp(retained.nodename, original.nodename) &&
            private_word == 17, "parent namespace and private memory retained");
    require(msgctl(queue, IPC_STAT, &state) == 0 && msgctl(queue, IPC_RMID, NULL) == 0,
            "parent IPC object remains usable and is removed");
    no_children();
    printf("clone namespaces: %s UTS/IPC isolation, private memory and atomic PIDFD pass\n", api);

    child = create(CLONE_NEWPID, NULL);
    require(child >= 0, "standard clone3 PID namespace");
    if (!child) {
        require(getpid() == 1 && getppid() == 0, "new PID namespace init and external parent");
        _exit(37);
    }
    require(child > 1, "parent receives the outer namespace PID");
    reap(child, 37);
    no_children();
    printf("clone namespaces: %s PID namespace init identity, outer PID and wait cleanup pass\n", api);

    child = fork();
    require(child >= 0, "ordinary permission-check worker");
    if (!child) {
        require(setgid(65534) == 0 && setuid(65534) == 0 && geteuid() == 65534,
                "drop namespace administrative privilege");
        int denied_fd = -1;
        errno = 0;
        pid_t denied = create(CLONE_NEWUTS | CLONE_PIDFD, &denied_fd);
        if (!denied) _exit(91);
        require(denied == -1 && errno == EPERM && denied_fd == -1,
                "Linux namespace permission denial preserves PIDFD output");
        no_children();
        pid_t recovery = fork();
        require(recovery >= 0, "ordinary fork after namespace denial");
        if (!recovery) _exit(41);
        reap(recovery, 41);
        no_children();
        _exit(43);
    }
    reap(child, 43);
    no_children();
    printf("clone namespaces: %s kernel EPERM rollback, unchanged PIDFD and later ordinary fork pass\n", api);
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages across fork");
    run(0);
    run(1);
    puts("::vm-test::pass");
    for (;;) pause();
}
