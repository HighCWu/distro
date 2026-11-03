// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((import_module("linux"), import_name("get_thread_area")))
extern uintptr_t thread_pointer(void);
static _Thread_local volatile int value = 17;
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: exec thread state: %s errno=%d\n", what, errno);
    exit(1);
}
static void spawn_wait(const char *path, const char *argument, int expected)
{
    char *args[] = { (char *)path, (char *)argument, NULL };
    char *env[] = { NULL };
    pid_t child;
    int status;
    require(posix_spawn(&child, path, NULL, NULL, args, env) == 0, "standard spawn/exec");
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) &&
            WEXITSTATUS(status) == expected, "new image thread state");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reaping");
}
int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(thread_pointer() && value == 17, "ordinary libc initializes TLS");
    if (argc == 2 && !strcmp(argv[1], "child")) return 61;
    uintptr_t original = thread_pointer();
    value = 29;
    char *args[] = { "/absent-exec-thread-state", NULL };
    char *env[] = { NULL };
    errno = 0;
    require(execve(args[0], args, env) == -1 && errno == ENOENT,
            "missing executable returns before commit");
    require(thread_pointer() == original && value == 29, "missing image retains TLS");
    char path[] = "/exec-thread-bad.XXXXXX";
    int fd = mkstemp(path);
    require(fd >= 0 && fchmod(fd, 0755) == 0 &&
            write(fd, "\0asm\1\0\0\0", 8) == 8 && close(fd) == 0, "malformed image fixture");
    args[0] = path;
    errno = 0;
    require(execve(path, args, env) == -1 && errno == ENOEXEC, "malformed module abort");
    require(thread_pointer() == original && value == 29 && unlink(path) == 0,
            "prepared image failure retains original thread state");
    puts("exec thread state: failed image lookup and preparation preserve original TLS pass");
    for (int i = 0; i < 2; i++) {
        spawn_wait("/exec-thread-entry", NULL, 0);
        require(thread_pointer() == original && value == 29, "parent TLS remains after raw entry");
    }
    puts("exec thread state: libc-free entry observes cleared kernel TP after exec commit pass");
    spawn_wait("/exec-thread-self", "child", 61);
    require(thread_pointer() == original && value == 29, "parent isolation and later libc exec");
    spawn_wait("/exec-thread-entry", NULL, 0);
    puts("exec thread state: fresh libc TLS, parent isolation and later exec recovery pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
