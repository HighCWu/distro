// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: public-syscall: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

int main(void)
{
    long pid = syscall(SYS_getpid);
    long (*raw)(long, ...) = &syscall;
    require(pid == getpid() && raw(SYS_getpid, 0L, 0L, 0L, 0L, 0L, 0L) == pid,
            "zero-argument call and existing function symbol");
    errno = 0;
    require(syscall(SYS_close, -1) == -1 && errno == EBADF, "negative int argument and errno");
    puts("public-syscall: direct calls, existing function symbol and errno pass");
    fflush(stdout);

    int pipes[2];
    require(pipe(pipes) == 0, "pipe setup");
    int first = fcntl(pipes[0], F_DUPFD_CLOEXEC, 40);
    int middle = fcntl(pipes[0], F_DUPFD_CLOEXEC, 41);
    int last = fcntl(pipes[0], F_DUPFD_CLOEXEC, 42);
    require(first == 40 && middle == 41 && last == 42, "known descriptor range");
    /* Deliberately use ordinary consecutive int arguments, not long casts. */
    require(syscall(SYS_close_range, middle, middle, 0) == 0, "consecutive int close_range arguments");
    errno = 0;
    require(fcntl(middle, F_GETFD) == -1 && errno == EBADF &&
            fcntl(first, F_GETFD) >= 0 && fcntl(last, F_GETFD) >= 0, "only requested fd closes");
    errno = 0;
    require(syscall(SYS_close_range, first, last, 1) == -1 && errno == EINVAL &&
            fcntl(first, F_GETFD) >= 0 && fcntl(last, F_GETFD) >= 0, "invalid flags preserve live fds");
    require(close(first) == 0 && close(last) == 0 && close(pipes[0]) == 0 && close(pipes[1]) == 0,
            "descriptor cleanup");
    puts("public-syscall: mixed int close_range positions, errors and fd preservation pass");
    fflush(stdout);

    struct { unsigned char before; char path[128]; unsigned char after; } output;
    memset(&output, 0x5a, sizeof output);
    require(chdir("/") == 0, "known working directory");
    /* Pointer followed by an ordinary int size, as typical syscall callers use. */
    require(syscall(SYS_getcwd, output.path, (int)sizeof output.path) == 2 &&
            !strcmp(output.path, "/") && output.before == 0x5a && output.after == 0x5a,
            "mixed pointer and int capacity");
    puts("public-syscall: pointer/int buffer call and bounded output pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
