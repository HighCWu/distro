// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile int marker = 11, expected = 11;
static volatile sig_atomic_t received, bad, try_fork;
static volatile int private_value = 61;
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: fork poll: %s errno=%d\n", what, errno);
    exit(1);
}
static void handler(int sig)
{
    if (sig != SIGALRM || marker != expected) bad = 1;
    if (try_fork) {
        int saved = errno;
        if (fork() != -1 || errno != EOPNOTSUPP) bad = 1;
        errno = saved;
    }
    received++;
}
static void compute(void)
{
    received = 0;
    struct itimerval timer = { .it_value = { .tv_usec = 50000 } };
    require(setitimer(ITIMER_REAL, &timer, NULL) == 0, "arm standard timer");
    /* No syscall or clock read: actual compiler checkpoints must enter Linux. */
    uint64_t count = 0;
    while (!received && count < (UINT64_C(1) << 33)) count++;
    require(received && !bad && marker == expected, "timer during pure computation");
}
static void reap(pid_t pid, int code)
{
    int status;
    require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == code,
            "exact continuation child status");
    errno = 0;
    require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single reaping");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    struct sigaction action = { .sa_handler = handler };
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGALRM, &action, NULL) == 0, "install handler");
    compute();
    puts("fork poll: compiler checkpoints deliver timer before continuation fork pass");
    for (int round = 0; round < 2; round++) {
        pid_t child = fork();
        require(child >= 0, "ordinary fork");
        if (!child) {
            marker = expected = 22; private_value = 99;
            compute();
            pid_t grandchild = fork();
            require(grandchild >= 0, "nested process fork");
            if (!grandchild) {
                marker = expected = 33; private_value = 101;
                compute();
                _exit(38);
            }
            reap(grandchild, 38);
            require(marker == 22 && private_value == 99, "child private TLS and globals");
            compute();
            _exit(37);
        }
        compute();
        reap(child, 37);
        require(marker == 11 && private_value == 61, "parent private TLS and globals");
    }
    puts("fork poll: parent child grandchild computation, private TLS and repeated fork wait pass");
    try_fork = 1;
    compute();
    try_fork = 0;
    pid_t child = fork();
    require(child >= 0, "later fork after callback refusal");
    if (!child) { compute(); _exit(39); }
    reap(child, 39);
    compute();
    puts("fork poll: signal callback fork stays refused and later fork and timer recover pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
