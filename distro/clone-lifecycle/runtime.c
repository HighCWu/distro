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
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: clone lifecycle: %s errno=%d\n", what, errno);
    exit(1);
}
static pid_t create(uint64_t flags, int signal, int *fd)
{
    struct clone_args args = { .flags = flags, .exit_signal = signal, .pidfd = (uintptr_t)fd };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args, 0L, 0L, 0L, 0L);
}
static long probe(int fd)
{
    return syscall(SYS_pidfd_send_signal, (long)fd, 0L, 0L, 0L, 0L, 0L);
}
static void token(int fd, int writing)
{
    char byte = 'R';
    if (writing) require(write(fd, &byte, 1) == 1, "write synchronization token");
    else {
        struct pollfd event = { .fd = fd, .events = POLLIN };
        require(poll(&event, 1, 5000) == 1 && (event.revents & POLLIN), "bounded synchronization");
        require(read(fd, &byte, 1) == 1 && byte == 'R', "read synchronization token");
    }
}
static short exited(int fd, int released)
{
    struct timespec start, now, delay = { .tv_nsec = 1000000 };
    require(clock_gettime(CLOCK_MONOTONIC, &start) == 0, "start PIDFD deadline");
    for (;;) {
        struct pollfd event = { .fd = fd, .events = POLLIN };
        int result = poll(&event, 1, 100);
        require(result >= 0 && !(event.revents & POLLNVAL), "poll PIDFD");
        if ((event.revents & POLLIN) && (!released || (event.revents & POLLHUP))) return event.revents;
        require(clock_gettime(CLOCK_MONOTONIC, &now) == 0 && now.tv_sec - start.tv_sec < 5,
                "PIDFD must report exit and requested task release");
        require(nanosleep(&delay, NULL) == 0, "yield for task release");
    }
}
static void empty(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD,
            "no waitable child in any Linux wait class");
}
static void automatic_reaping(int automatic)
{
    int ready[2], release[2], fd = -1;
    require(pipe(ready) == 0 && pipe(release) == 0, "control pipes");
    pid_t child = create(CLONE_PIDFD | (automatic ? CLONE_AUTOREAP : 0), 0, &fd);
    require(child >= 0, "clone3 with selected reaping behavior");
    if (!child) {
        close(ready[0]); close(release[1]);
        token(ready[1], 1); token(release[0], 0);
        _exit(37);
    }
    require(close(ready[1]) == 0 && close(release[0]) == 0, "parent pipe ownership");
    token(ready[0], 0);
    require(probe(fd) == 0, "child lives before release");
    token(release[1], 1);
    short events = exited(fd, automatic);
    if (automatic) empty();
    else {
        require(!(events & POLLHUP), "ordinary zero-signal child remains a zombie until wait");
        int status;
        require(waitpid(child, &status, __WCLONE) == child && WIFEXITED(status) &&
                WEXITSTATUS(status) == 37, "ordinary child needs exact clone-class reaping");
        exited(fd, 1);
        empty();
    }
    errno = 0;
    require(probe(fd) == -1 && errno == ESRCH, "released PIDFD no longer addresses a task");
    require(close(fd) == 0 && close(ready[0]) == 0 && close(release[1]) == 0, "release owned fds");
}
static void last_close_kills(void)
{
    int ready[2], fd = -1;
    require(pipe(ready) == 0, "autokill readiness pipe");
    pid_t child = create(CLONE_PIDFD | CLONE_AUTOREAP | CLONE_PIDFD_AUTOKILL | CLONE_NNP, 0, &fd);
    require(child >= 0, "clone3 with PIDFD-managed lifetime");
    if (!child) {
        close(ready[0]);
        require(syscall(SYS_prctl, (long)PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L, 0L) == 1,
                "autokill child has kernel-installed no_new_privs");
        token(ready[1], 1);
        for (;;) pause();
    }
    require(close(ready[1]) == 0, "parent closes readiness writer");
    token(ready[0], 0);
    int duplicate = dup(fd);
    int observer = syscall(SYS_pidfd_open, (long)child, 0L, 0L, 0L, 0L, 0L);
    require(duplicate >= 0 && observer >= 0, "duplicate owner and independent observing PIDFD");
    require(close(fd) == 0 && probe(duplicate) == 0 && probe(observer) == 0,
            "closing one duplicate does not kill child");
    require(close(duplicate) == 0, "last owning PIDFD close");
    exited(observer, 1);
    empty();
    errno = 0;
    require(probe(observer) == -1 && errno == ESRCH, "last close killed and autoreaped paused child");
    require(close(observer) == 0 && close(ready[0]) == 0, "autokill fd cleanup");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    automatic_reaping(0);
    puts("clone lifecycle: ordinary zero-signal child stays waitable until explicit reaping pass");
    automatic_reaping(1);
    puts("clone lifecycle: AUTOREAP releases task without wait and PIDFD reports HUP pass");
    last_close_kills();
    puts("clone lifecycle: AUTOKILL waits for last dup close and independent observer sees task release pass");
    const uint64_t invalid[] = { CLONE_AUTOREAP | CLONE_PIDFD,
        CLONE_PIDFD_AUTOKILL | CLONE_PIDFD | CLONE_NNP,
        CLONE_PIDFD_AUTOKILL | CLONE_AUTOREAP | CLONE_NNP };
    for (unsigned i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
        int fd = -91;
        errno = 0;
        pid_t child = create(invalid[i], i ? 0 : SIGCHLD, &fd);
        if (!child) _exit(99);
        require(child == -1 && errno == EINVAL && fd == -91, "Linux rejects invalid flag combinations before PIDFD publication");
        empty();
    }
    pid_t child = fork();
    require(child >= 0, "ordinary fork after rejected requests");
    if (!child) _exit(38);
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 38,
            "later ordinary fork keeps SIGCHLD and remains waitable");
    empty();
    puts("clone lifecycle: invalid combinations leave no PIDFD or child and later fork recovers pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
