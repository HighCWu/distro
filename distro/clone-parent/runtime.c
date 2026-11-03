// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#if !defined(__wasm__) && !defined(__x86_64__)
#error "Native reference requires the x86-64 clone register layout"
#endif
#include <errno.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: clone parent: %s errno=%d\n", what, errno);
    exit(1);
}
static pid_t create(int legacy)
{
    if (legacy)
        return syscall(SYS_clone, (long)(CLONE_PARENT | SIGCHLD), 0L, 0L, 0L, 0L, 0L);
    struct clone_args args = { .flags = CLONE_PARENT, .exit_signal = 0 };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args, 0L, 0L, 0L, 0L);
}
static void receive(int fd, void *data, size_t size)
{
    struct pollfd event = { .fd = fd, .events = POLLIN };
    require(poll(&event, 1, 5000) == 1 && (event.revents & POLLIN), "bounded process handshake");
    require(read(fd, data, size) == (ssize_t)size, "exact process report");
}
static void reap(pid_t child, int expected)
{
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
            "real parent reaps exact child through ordinary wait");
    errno = 0;
    require(waitpid(child, &status, __WALL | WNOHANG) == -1 && errno == ECHILD, "single reaping");
}
static void scenario(int legacy)
{
    int report[2], release[2];
    require(pipe(report) == 0 && pipe(release) == 0, "create process handshakes");
    pid_t controller = getpid();
    pid_t caller = fork();
    require(caller >= 0, "create live clone caller");
    if (!caller) {
        close(report[0]); close(release[1]);
        pid_t sibling = create(legacy);
        require(sibling >= 0, "clone with caller's parent");
        if (!sibling) {
            require(getppid() == controller, "new child has controller as its real parent");
            _exit(37);
        }
        int status;
        errno = 0;
        require(waitpid(sibling, &status, __WALL | WNOHANG) == -1 && errno == ECHILD,
                "caller cannot wait its new sibling");
        pid_t pair[2] = { getpid(), sibling };
        require(write(report[1], pair, sizeof pair) == sizeof pair, "publish kernel PIDs");
        char token;
        receive(release[0], &token, 1);
        require(token == 'R', "controller releases caller only after reaping sibling");
        _exit(38);
    }
    require(close(report[1]) == 0 && close(release[0]) == 0, "controller pipe ownership");
    pid_t pair[2];
    receive(report[0], pair, sizeof pair);
    require(pair[0] == caller && pair[1] > 0 && pair[1] != caller && pair[1] != controller,
            "reported PIDs identify caller and separate adopted child");
    reap(pair[1], 37);
    require(kill(caller, 0) == 0, "caller still exists while controller reaps sibling");
    char token = 'R';
    require(write(release[1], &token, 1) == 1, "release live caller");
    reap(caller, 38);
    require(close(report[0]) == 0 && close(release[1]) == 0, "close owned process pipes");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
#ifdef __wasm__
    require(getpid() == 1, "isolated namespace-init fixture");
    scenario(0);
    puts("clone parent: native clone3 assigns controller parent and caller cannot reap sibling pass");
#endif
    scenario(1);
    puts("clone parent: legacy clone assigns controller parent while caller remains alive pass");
    if (getpid() == 1) {
        for (int legacy = 0; legacy < 2; legacy++) {
            errno = 0;
            pid_t child = create(legacy);
            if (!child) _exit(99);
            require(child == -1 && errno == EINVAL, "Linux forbids init from creating siblings");
        }
    }
    pid_t child = fork();
    require(child >= 0, "later ordinary fork");
    if (!child) _exit(39);
    reap(child, 39);
    int status;
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD, "all processes reaped");
    puts("clone parent: ordinary fork parentage and cleanup recover pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
