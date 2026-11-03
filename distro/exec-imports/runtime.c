// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((import_module("linux"), import_name("get_thread_area")))
extern uintptr_t thread_pointer(void);
static _Thread_local volatile int marker = 17;
static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: exec imports: %s errno=%d\n", what, errno);
    exit(1);
}
static void reject(const char *path, uintptr_t tp, int fd)
{
    char *args[] = { (char *)path, NULL }, *env[] = { NULL };
    errno = 0;
    require(execve(path, args, env) == -1 && errno == ENOEXEC,
            "incompatible import returns ENOEXEC before image commit");
    require(thread_pointer() == tp && marker == 29 &&
            fcntl(fd, F_GETFD) == FD_CLOEXEC && lseek(fd, 0, SEEK_CUR) == 1,
            "old TP, native TLS, CLOEXEC descriptor and offset survive");
}
static void accepted(void)
{
    char *args[] = { "/exec-import-good", NULL }, *env[] = { NULL };
    pid_t child;
    int status;
    require(posix_spawn(&child, args[0], NULL, NULL, args, env) == 0,
            "matching global contract must execute");
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) &&
            WEXITSTATUS(status) == 0, "matching image exits through standard syscall");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reaping");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    uintptr_t original = thread_pointer();
    require(original && marker == 17, "initial TLS");
    marker = 29;
    int fd = open("/exec-import-good", O_RDONLY | O_CLOEXEC);
    require(fd >= 0 && lseek(fd, 1, SEEK_SET) == 1, "CLOEXEC rollback fixture");
    for (int i = 0; i < 2; i++) {
        reject("/exec-import-immutable", original, fd);
        reject("/exec-import-width", original, fd);
        reject("/exec-import-float", original, fd);
    }
    puts("exec imports: valid Wasm with incompatible global type or mutability returns ENOEXEC pass");
    for (int i = 0; i < 2; i++) {
        reject("/exec-import-syscall-width", original, fd);
        reject("/exec-import-syscall-result", original, fd);
        reject("/exec-import-syscall-arity", original, fd);
        reject("/exec-import-poll-result", original, fd);
    }
    puts("exec imports: syscall and checkpoint function types return ENOEXEC before commit pass");
    for (int i = 0; i < 2; i++) {
        reject("/exec-import-entry-missing", original, fd);
        reject("/exec-import-entry-argument", original, fd);
        reject("/exec-import-entry-result", original, fd);
        reject("/exec-import-entry-kind", original, fd);
    }
    puts("exec imports: missing or incompatible entry returns ENOEXEC before image commit pass");
    accepted();
    require(thread_pointer() == original && marker == 29 && fcntl(fd, F_GETFD) == FD_CLOEXEC,
            "parent state after matching image");
    puts("exec imports: matching global ABI executes and parent TLS and CLOEXEC fd remain pass");
    reject("/exec-import-width", original, fd);
    accepted();
    require(close(fd) == 0, "release rollback descriptor");
    puts("exec imports: repeated preparation failure and later spawn wait recover pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
