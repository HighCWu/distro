// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <setjmp.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile sig_atomic_t received, bad_handler, jump_enabled;
static _Thread_local volatile unsigned marker = 11;
static sigjmp_buf jump;
static atomic_int ready;

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: cooperative poll: %s errno=%d\n", what, errno);
    exit(1);
}

static void handler(int sig)
{
    if ((sig == SIGALRM && marker != 11) || (sig == SIGUSR1 && marker != 22)) bad_handler = 1;
    received++;
    if (jump_enabled) siglongjmp(jump, 1);
}

static void arm(void)
{
    struct itimerval timer = { .it_value = { .tv_usec = 50000 } };
    require(setitimer(ITIMER_REAL, &timer, NULL) == 0, "arm timer");
}

/* No syscalls, sleeps or clock reads: only compiler-inserted checkpoints can
 * return to Linux. The finite bound makes missing delivery an explicit error. */
static int spin(void)
{
    uint64_t count = 0;
    while (!received && count < (UINT64_C(1) << 34)) count++;
    return received && !bad_handler;
}

static void *thread_main(void *arg)
{
    (void)arg;
    marker = 22;
    atomic_store(&ready, 1);
    return (void *)(uintptr_t)(!spin() || marker != 22);
}

int main(int argc, char **argv)
{
    struct sigaction action = { .sa_handler = handler };
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGALRM, &action, NULL) == 0 &&
            sigaction(SIGUSR1, &action, NULL) == 0, "install handlers");
    if (argc == 2 && !strcmp(argv[1], "strict")) {
        arm();
        require(prctl(PR_SET_SECCOMP, 1L, 0L, 0L, 0L) == 0, "strict seccomp");
        /* No libc exit_group or post-policy diagnostic syscalls. */
        long status = spin() ? 0 : 1;
        syscall(SYS_exit, status, 0L, 0L, 0L, 0L, 0L);
        __builtin_trap();
    }
    setvbuf(stdout, NULL, _IONBF, 0);
    arm();
    require(spin() && marker == 11, "timer in pure computation");
    puts("cooperative poll: pure computation receives standard timer signal pass");

    received = 0;
    if (sigsetjmp(jump, 1) == 0) {
        jump_enabled = 1;
        arm();
        (void)spin();
        require(0, "handler must leave through siglongjmp");
    }
    jump_enabled = 0;
    received = 0;
    arm();
    require(spin() && marker == 11, "later checkpoint after siglongjmp");
    puts("cooperative poll: siglongjmp restores execution and later timer delivery pass");

    received = 0;
    pthread_t thread;
    require(pthread_create(&thread, NULL, thread_main, NULL) == 0, "create thread");
    while (!atomic_load(&ready)) sched_yield();
    require(pthread_kill(thread, SIGUSR1) == 0, "target thread");
    void *result = (void *)1;
    require(pthread_join(thread, &result) == 0 && result == NULL &&
            received == 0 && marker == 11 && !bad_handler, "thread signal and native TLS isolation");
    puts("cooperative poll: targeted pthread signal and independent native TLS pass");

    pid_t child;
    char *args[] = { "/poll-helper", "strict", NULL };
    char *environment[] = { NULL };
    require(posix_spawn(&child, args[0], NULL, NULL, args, environment) == 0, "spawn strict helper");
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "checkpoint must not manufacture forbidden syscalls");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reaping");
    puts("cooperative poll: strict seccomp pure-loop timer, raw exit and single reaping pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
