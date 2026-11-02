// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: clone flags64: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static void handler(int sig) { (void)sig; }

static void dispositions(int cleared)
{
    struct sigaction action;
    require(sigaction(SIGUSR1, NULL, &action) == 0 &&
            action.sa_handler == (cleared ? SIG_DFL : handler), "USR1 disposition");
    require(sigaction(SIGUSR2, NULL, &action) == 0 && action.sa_handler == SIG_IGN,
            "ignored disposition remains ignored");
}

static void no_children(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "no unreaped children");
}

static void reap(pid_t child, int signaled)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && (signaled ? (WIFSIGNALED(status) && WTERMSIG(status) == SIGUSR1)
            : (WIFEXITED(status) && WEXITSTATUS(status) == 37)), "actual child termination");
    no_children();
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    struct sigaction old1, old2, action = { .sa_handler = handler };
    require(sigemptyset(&action.sa_mask) == 0 &&
            sigaction(SIGUSR1, &action, &old1) == 0, "install custom handler");
    action.sa_handler = SIG_IGN;
    require(sigaction(SIGUSR2, &action, &old2) == 0, "install ignored handler");
    int pidfd = -1;
    struct clone_args args = { .flags = CLONE_CLEAR_SIGHAND | CLONE_PIDFD,
        .pidfd = (uintptr_t)&pidfd, .exit_signal = SIGCHLD };
    _Static_assert(sizeof args == 88, "aligned u64 clone_args");
    pid_t child = syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args);
    require(child >= 0, "clone3 high flags and PIDFD");
    if (!child) {
        dispositions(1);
        require(syscall(SYS_kill, (long)getpid(), (long)SIGUSR2) == 0, "deliver ignored signal");
        /* Raw clone does not repair libc's cached TID. Target the actual PID
         * with a standard syscall rather than raise()/pthread_self(). */
        syscall(SYS_kill, (long)getpid(), (long)SIGUSR1);
        _exit(99);
    }
    dispositions(0);
    int fd_flags = fcntl(pidfd, F_GETFD);
    require(pidfd >= 0 && fd_flags >= 0 && (fd_flags & FD_CLOEXEC), "atomic PIDFD");
    reap(child, 1);
    require(close(pidfd) == 0, "PIDFD cleanup");
    puts("clone flags64: kernel clears custom handler, retains IGN and delivers default signal pass");

    args.flags = CLONE_CLEAR_SIGHAND | CLONE_SIGHAND;
    args.pidfd = 0;
    errno = 0;
    child = syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args);
    if (!child) _exit(97);
    require(child == -1 && errno == EINVAL, "CLEAR_SIGHAND/SIGHAND conflict");
    no_children();
    dispositions(0);
    puts("clone flags64: conflicting shared/cleared handlers reject without a child pass");

    child = fork();
    require(child >= 0, "later ordinary fork");
    if (!child) { dispositions(0); _exit(37); }
    reap(child, 0);
    require(sigaction(SIGUSR1, &old1, NULL) == 0 && sigaction(SIGUSR2, &old2, NULL) == 0,
            "restore parent dispositions");
    puts("clone flags64: later ordinary fork inherits parent handlers and cleanup pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
