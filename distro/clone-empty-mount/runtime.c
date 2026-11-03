// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only inside the isolated Linux/Wasm mount test"
#endif
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define A "/clone-empty-a"
#define B "/clone-empty-b"
static struct stat underlying, mounted;
static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: clone empty mount: %s errno=%d\n", what, errno);
    exit(1);
}
static void make_file(const char *path)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(fd >= 0 && write(fd, "marker", 6) == 6 && close(fd) == 0, "create exact fixture file");
}
static void missing(const char *path)
{
    struct stat state;
    errno = 0;
    require(stat(path, &state) == -1 && errno == ENOENT, "expected path absent in this mount view");
}
static void identity(const char *path, const struct stat *expected)
{
    struct stat state;
    require(stat(path, &state) == 0 && state.st_dev == expected->st_dev && state.st_ino == expected->st_ino,
            "exact backing inode visible in selected namespace");
}
static void cwd(const char *expected)
{
    char buffer[256];
    require(getcwd(buffer, sizeof buffer) && !strcmp(buffer, expected), "kernel-selected working directory");
}
static pid_t create(uint64_t flags)
{
    struct clone_args args = { .flags = flags, .exit_signal = SIGCHLD };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args, 0L, 0L, 0L, 0L);
}
static void reap(pid_t child)
{
    int status;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
            "exact namespace child status");
    errno = 0;
    require(waitpid(child, &status, __WALL | WNOHANG) == -1 && errno == ECHILD, "single child reaping");
}
static void parent_view(void)
{
    cwd(B "/inner");
    identity(A "/mounted", &mounted);
    missing(A "/under");
    missing(A "/child-only");
    struct stat state;
    require(stat(B "/mounted", &state) == 0, "parent second mount retained");
}
static void scenario(uint64_t flags, int empty)
{
    pid_t child = create(flags);
    require(child >= 0, "native clone3 mount namespace");
    if (!child) {
        if (empty) {
            cwd("/");
            identity(A "/under", &underlying);
            missing(A "/mounted");
            missing(B "/mounted");
            missing(B "/inner");
        } else parent_view();
        struct stat init;
        require(stat("/init", &init) == 0 && S_ISREG(init.st_mode), "root mount remains accessible");
        require(chdir("/") == 0 && mount("ramfs", A, "ramfs", 0, NULL) == 0, "child-only mount");
        make_file(A "/child-only");
        _exit(37);
    }
    reap(child);
    parent_view();
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(mount(NULL, "/", NULL, MS_PRIVATE | MS_REC, NULL) == 0, "private fixture propagation");
    require(mkdir(A, 0700) == 0 && mkdir(B, 0700) == 0, "root mountpoint fixtures");
    make_file(A "/under"); make_file(B "/under");
    require(stat(A "/under", &underlying) == 0, "record underlying root inode");
    require(mount("ramfs", A, "ramfs", 0, NULL) == 0 && mount("ramfs", B, "ramfs", 0, NULL) == 0,
            "two child mounts");
    make_file(A "/mounted"); make_file(B "/mounted");
    require(mkdir(B "/inner", 0700) == 0 && chdir(B "/inner") == 0, "parent cwd inside child mount");
    require(stat(A "/mounted", &mounted) == 0, "record mounted inode");
    scenario(CLONE_NEWNS, 0);
    puts("clone empty mount: ordinary NEWNS retains copied mounts and cwd with isolated child mount pass");
    scenario(CLONE_EMPTY_MNTNS, 1);
    puts("clone empty mount: EMPTY_MNTNS implies new namespace, removes child mounts and resets cwd pass");
    scenario(CLONE_EMPTY_MNTNS | CLONE_NEWNS, 1);
    puts("clone empty mount: explicit NEWNS combination retains only root and preserves parent view pass");
    errno = 0;
    pid_t rejected = create(CLONE_EMPTY_MNTNS | CLONE_FS);
    if (!rejected) _exit(99);
    require(rejected == -1 && errno == EINVAL, "Linux rejects implied NEWNS and shared FS conflict");
    parent_view();
    pid_t child = fork();
    require(child >= 0, "ordinary fork after rejected mount request");
    if (!child) { parent_view(); _exit(37); }
    reap(child);
    require(chdir("/") == 0 && umount(A) == 0 && umount(B) == 0, "release parent mount references");
    identity(A "/under", &underlying);
    require(unlink(A "/under") == 0 && unlink(B "/under") == 0 && rmdir(A) == 0 && rmdir(B) == 0,
            "underlying filesystem cleanup");
    int status;
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD, "no remaining children");
    puts("clone empty mount: conflict leaves parent unchanged and ordinary fork and filesystem cleanup recover pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
