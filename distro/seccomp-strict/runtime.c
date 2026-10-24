// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef __wasm__
__attribute__((import_module("linux_fork_v1"), import_name("checkpoint")))
extern int legacy_checkpoint(unsigned long);
#endif

/* Standard syscall numbers, with all six variadic arguments machine words. */
static long call(long nr, long a, long b, long c)
{
    return syscall(nr, a, b, c, 0L, 0L, 0L);
}

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: seccomp-strict: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static void raw_exit(int status)
{
    call(SYS_exit, status, 0, 0);
    __builtin_trap();
}

static int response;
static void handler(int sig)
{
    const char byte = sig == SIGUSR1 ? 'H' : '?';
    if (call(SYS_write, response, (long)&byte, 1) != 1) raw_exit(83);
}

static void checked_read(int fd, char expected)
{
    char byte = 0;
    long result;
    do result = call(SYS_read, fd, (long)&byte, 1); while (result < 0 && errno == EINTR);
    require(result == 1 && byte == expected, "pipe protocol");
}

int main(void)
{
    require(prctl(PR_GET_SECCOMP, 0L, 0L, 0L, 0L) == 0, "initial mode disabled");
    errno = 0;
    require(call(SYS_seccomp, SECCOMP_SET_MODE_STRICT, 1, 0) == -1 && errno == EINVAL, "strict rejects flags");
    errno = 0;
    require(call(SYS_seccomp, SECCOMP_SET_MODE_STRICT, 0, 1) == -1 && errno == EINVAL, "strict rejects argument");
    errno = 0;
    require(call(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, 0) == -1 && errno == EINVAL, "filter remains unsupported");
    require(prctl(PR_GET_SECCOMP, 0L, 0L, 0L, 0L) == 0, "rejections preserve disabled mode");
    puts("seccomp-strict: standard query and invalid requests preserve mode pass");
    fflush(stdout);

    for (int mode = 0; mode < 9; ++mode) {
        int commands[2], replies[2];
        require(pipe(commands) == 0 && pipe(replies) == 0, "pipes before fork");
        response = replies[1];
        struct sigaction action = {0};
        action.sa_handler = handler;
        sigemptyset(&action.sa_mask);
        require(sigaction(SIGUSR1, &action, NULL) == 0, "handler before restriction");
        pid_t child = fork();
        require(child >= 0, "single-thread controller fork");
        if (!child) {
            close(commands[1]);
            close(replies[0]);
            long entered = mode == 1 ? prctl(PR_SET_SECCOMP, (long)SECCOMP_MODE_STRICT, 0L, 0L, 0L) :
                                      call(SYS_seccomp, SECCOMP_SET_MODE_STRICT, 0, 0);
            if (entered != 0) raw_exit(81);
            const char ready = 'A';
            if (call(SYS_write, response, (long)&ready, 1) != 1) raw_exit(82);
            if (mode < 2) {
                char command;
                long result;
                do result = call(SYS_read, commands[0], (long)&command, 1);
                while (result < 0 && errno == EINTR);
                if (result != 1 || command != 'B') raw_exit(84);
                const char done = 'D';
                if (call(SYS_write, response, (long)&done, 1) != 1) raw_exit(85);
                raw_exit(37);
            }
            if (mode == 2) call(SYS_getpid, 0, 0, 0);
            if (mode == 3) call(SYS_exit_group, 38, 0, 0);
            if (mode == 4) prctl(PR_SET_SECCOMP, 0L, 0L, 0L, 0L);
            /* Wasm has no rt_sigreturn syscall, even under strict mode. */
            if (mode == 5) call(139, 0, 0, 0);
            /* These must reach kernel policy before local argument refusal. */
            if (mode == 6) call(SYS_clone, 0, 0, 0);
            if (mode == 7) call(SYS_clone3, 0, 0, 0);
#ifdef __wasm__
            if (mode == 8) legacy_checkpoint(0);
#else
            if (mode == 8) call(SYS_clone, 0, 0, 0);
#endif
            raw_exit(86); /* A forbidden call must never return. */
        }
        close(commands[0]);
        close(replies[1]);
        checked_read(replies[0], 'A');
        if (mode < 2) {
            require(kill(child, SIGUSR1) == 0, "deliver signal under strict policy");
            checked_read(replies[0], 'H');
            require(call(SYS_write, commands[1], (long)"B", 1) == 1, "release strict read");
            checked_read(replies[0], 'D');
        }
        int status = 0;
        pid_t waited;
        do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
        if (waited != child || (mode < 2 ? !WIFEXITED(status) || WEXITSTATUS(status) != 37 :
                                          !WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)) {
            printf("seccomp-strict: mode=%d waited=%ld status=%#x\n", mode, (long)waited, status);
            require(0, "allowed completion or forbidden syscall SIGKILL");
        }
        close(commands[1]);
        close(replies[0]);
        errno = 0;
        require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
        require(prctl(PR_GET_SECCOMP, 0L, 0L, 0L, 0L) == 0 && getpid() > 0,
                "child restriction must not affect parent");
        if (mode == 1) puts("seccomp-strict: syscall and prctl entry allow read write exit and signal return pass");
    }
    puts("seccomp-strict: forbidden calls terminate and cannot disable strict policy pass");
    puts("seccomp-strict: parent mode isolation repeated fork wait and cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
