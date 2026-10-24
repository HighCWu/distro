// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

struct guarded_tid { uint32_t before; pid_t value; uint32_t after; };
static struct guarded_tid parent_word, child_word, tls_word;
static volatile int entered;
static volatile pid_t observed_tid;

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: clone-arguments: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static void reset(struct guarded_tid *word)
{
    word->before = UINT32_C(0x12345678);
    word->value = -91;
    word->after = UINT32_C(0x89abcdef);
}

static void intact(const struct guarded_tid *word)
{
    require(word->before == UINT32_C(0x12345678) && word->after == UINT32_C(0x89abcdef),
            "kernel TID store must preserve adjacent bytes");
}

/* CLONE_VM callback: no libc calls, TLS operations or parent-stack execution. */
static int child(void *arg)
{
    observed_tid = *(pid_t *)arg;
    entered = 1;
    return 37;
}

int main(void)
{
    const size_t stack_size = 128 * 1024;
    char *stack = malloc(stack_size);
    require(stack != NULL, "allocate callback stack");
    const int common = CLONE_VM | CLONE_VFORK | SIGCHLD;
    for (int mode = 0; mode < 5; ++mode) {
        reset(&parent_word);
        reset(&child_word);
        reset(&tls_word);
        entered = 0;
        observed_tid = -92;
        pid_t pid;
        /* No optional words, a one-word prefix, then the full fixed layout. */
        if (mode == 0) pid = clone(child, stack + stack_size, common, &child_word.value);
        else if (mode == 1) pid = clone(child, stack + stack_size,
                common | CLONE_PARENT_SETTID, &child_word.value, &parent_word.value);
        else if (mode == 2) pid = clone(child, stack + stack_size,
                common | CLONE_CHILD_SETTID, &child_word.value,
                &parent_word.value, (void *)&tls_word.value, &child_word.value);
        else if (mode == 3) pid = clone(child, stack + stack_size,
                common | CLONE_PARENT_SETTID | CLONE_CHILD_SETTID, &child_word.value,
                &parent_word.value, (void *)&tls_word.value, &child_word.value);
        else pid = clone(child, stack + stack_size,
                common | CLONE_PIDFD | CLONE_CHILD_SETTID, &child_word.value,
                &parent_word.value, (void *)&tls_word.value, &child_word.value);
        require(pid > 0, "public clone succeeds");
        if (mode == 4) {
            int fd = parent_word.value;
            int descriptor_flags = fcntl(fd, F_GETFD);
            require(fd >= 0 && descriptor_flags >= 0 && (descriptor_flags & FD_CLOEXEC), "atomic pidfd output");
            siginfo_t info = {0};
            require(waitid(P_PIDFD, (id_t)fd, &info, WEXITED) == 0 &&
                    info.si_pid == pid && info.si_code == CLD_EXITED && info.si_status == 37,
                    "pidfd names the exact cloned child");
            require(close(fd) == 0, "close owned pidfd");
        } else {
            int status = 0;
            require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 37,
                    "callback return and exact child wait");
        }
        require(entered == 1, "callback ran");
        require(child_word.value == (mode >= 2 ? pid : -91) &&
                observed_tid == child_word.value, "child_tid is visible before callback");
        require(tls_word.value == -91, "unused TLS placeholder must not become child_tid");
        if (mode < 4) require(parent_word.value == (mode == 1 || mode == 3 ? pid : -91),
                             "unused parent_tid placeholder must not be written");
        intact(&parent_word);
        intact(&child_word);
        intact(&tls_word);
        int status;
        errno = 0;
        require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single child reap");
        if (mode == 1) puts("clone-arguments: absent optional words and parent-only prefix pass");
        if (mode == 3) puts("clone-arguments: fixed slots child identity and untouched placeholders pass");
    }
    free(stack);
    puts("clone-arguments: combined pidfd child_tid exact wait and descriptor cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
