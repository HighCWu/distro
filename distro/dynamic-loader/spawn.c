// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile uint32_t process_value = 0x13579bdf;
static _Thread_local volatile uint32_t thread_value = 0x2468ace0;

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: dynamic spawn: %s errno=%d\n", what, errno);
    exit(1);
}

static void verify_parent(uint32_t process, uint32_t thread, int expected_errno)
{
    require(process_value == process, "parent mutable data survives spawn");
    require(thread_value == thread, "parent TLS survives spawn");
    require(errno == expected_errno, "parent errno survives spawn");
}

static int spawn_child_with_closed_fd(uint32_t process, uint32_t thread)
{
    int descriptors[2];
    require(pipe(descriptors) == 0, "create descriptor fixture");
    require(fcntl(descriptors[0], F_SETFD, 0) == 0, "make child descriptor inheritable");

    posix_spawn_file_actions_t actions;
    int error = posix_spawn_file_actions_init(&actions);
    require(error == 0, "initialize spawn file actions");
    error = posix_spawn_file_actions_addclose(&actions, descriptors[0]);
    require(error == 0, "add child close action");

    char fd_text[32];
    int length = snprintf(fd_text, sizeof(fd_text), "%d", descriptors[0]);
    require(length > 0 && (size_t)length < sizeof(fd_text), "format child descriptor");
    char *arguments[] = { (char *)"/init", (char *)"--spawn-child", fd_text, NULL };

    errno = EDOM;
    pid_t child = -1;
    error = posix_spawn(&child, "/init", &actions, NULL, arguments, environ);
    verify_parent(process, thread, EDOM);
    require(error == 0 && child > 0, "posix_spawn child image");
    require(fcntl(descriptors[0], F_GETFD) >= 0, "child close action leaves parent descriptor open");
    require(close(descriptors[0]) == 0 && close(descriptors[1]) == 0,
            "close parent descriptor fixture");
    require(posix_spawn_file_actions_destroy(&actions) == 0, "destroy spawn file actions");

    int status = 0;
    errno = EDOM;
    require(waitpid(child, &status, 0) == child, "wait for spawned image");
    require(errno == EDOM, "wait preserves parent errno");
    require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "spawned image validates closed fd");
    verify_parent(process, thread, EDOM);

    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD,
            "spawned image is reaped once");
    return 0;
}

static void child_main(int argc, char **argv)
{
    if (argc != 3 || strcmp(argv[1], "--spawn-child")) return;

    char *end = NULL;
    errno = 0;
    long descriptor = strtol(argv[2], &end, 10);
    if (errno || !end || *end || descriptor < 0 || descriptor > INT32_MAX) exit(21);
    if (process_value != 0x13579bdf || thread_value != 0x2468ace0) exit(22);
    errno = 0;
    if (fcntl((int)descriptor, F_GETFD) != -1 || errno != EBADF) exit(23);
    exit(0);
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    child_main(argc, argv);

    require(process_value == 0x13579bdf && thread_value == 0x2468ace0,
            "initial process data and TLS");
    process_value = 0x89abcdef;
    thread_value = 0xfedcba98;

    for (int i = 0; i < 2; i++) {
        require(spawn_child_with_closed_fd(process_value, thread_value) == 0,
                "first and second spawn/wait cycle");
        verify_parent(process_value, thread_value, ECHILD);
    }

    char *missing_arguments[] = { (char *)"/missing-dynamic-spawn-image", NULL };
    pid_t missing_child = -1;
    errno = EDOM;
    int missing = posix_spawn(&missing_child, missing_arguments[0], NULL, NULL,
                              missing_arguments, environ);
    require(missing == ENOENT, "missing executable reports ENOENT");
    require(process_value == 0x89abcdef && thread_value == 0xfedcba98,
            "failed spawn preserves parent data and TLS");

    require(spawn_child_with_closed_fd(process_value, thread_value) == 0,
            "spawn recovers after ENOENT");
    verify_parent(process_value, thread_value, ECHILD);

    puts("dynamic spawn: callback-vfork, exec, wait, fd actions and ENOENT recovery pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
