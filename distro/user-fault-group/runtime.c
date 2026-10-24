// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: user-fault-group: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

int main(int argc, char **argv)
{
    const char *helper = argc == 2 ? argv[1] : "/fault-helper";
    struct rlimit core = {0, 0};
    require(setrlimit(RLIMIT_CORE, &core) == 0, "disable core file output");
    const char *modes[] = {"unreachable", "bounds", "thread-exit"};
    for (int i = 0; i < 3; ++i) {
        pid_t child = fork();
        require(child >= 0, "fork single-thread controller");
        if (!child) {
            char *args[] = {"fault-helper", (char *)modes[i], NULL};
            char *env[] = {NULL};
            execve(helper, args, env);
            _exit(91);
        }
        int status = 0;
        pid_t waited;
        do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
        int correct = waited == child && (i == 2 ? WIFEXITED(status) && WEXITSTATUS(status) == 37 :
                                         WIFSIGNALED(status) && WTERMSIG(status) == SIGSEGV);
        if (!correct) printf("user-fault-group: case=%s waited=%ld status=%#x\n", modes[i], (long)waited, status);
        require(correct, i == 2 ? "SYS_exit must preserve the sibling" : "fatal worker must terminate its process");
        errno = 0;
        require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single process reap");
        const char *stages[] = {
            "user-fault-group: unreachable in a worker terminates all process threads pass",
            "user-fault-group: out-of-bounds worker trap terminates all process threads pass",
            "user-fault-group: raw SYS_exit remains thread-only and later parent wait recovers pass",
        };
        puts(stages[i]);
        fflush(stdout);
    }
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
