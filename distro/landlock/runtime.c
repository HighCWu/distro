// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef LANDLOCK_HELPER_PATH
#define LANDLOCK_HELPER_PATH "/landlock-helper"
#endif

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: landlock: %s errno=%d\n", what, errno);
    exit(1);
}

static void path(char *out, size_t size, const char *root, const char *suffix)
{
    int n = snprintf(out, size, "%s/%s", root, suffix);
    require(n > 0 && (size_t)n < size, "bounded path");
}

static void child(const char *mode, char *root)
{
    pid_t pid;
    char *args[] = {LANDLOCK_HELPER_PATH, (char *)mode, root, NULL};
    char *environment[] = {NULL};
    require(posix_spawn(&pid, args[0], NULL, NULL, args, environment) == 0,
            "spawn standard syscall consumer");
    int status;
    pid_t waited;
    do waited = waitpid(pid, &status, 0); while (waited < 0 && errno == EINTR);
    require(waited == pid && WIFEXITED(status) && WEXITSTATUS(status) == 37,
            "child policy and descriptor checks");
    errno = 0;
    require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(syscall(SYS_landlock_create_ruleset, 0L, 0L,
                    (long)LANDLOCK_CREATE_RULESET_VERSION, 0L, 0L, 0L) >= 1,
            "Landlock enabled and initialized");
    require(mkdir("/tmp", 0777) == 0 || errno == EEXIST, "temporary root");
    char root[] = "/tmp/landlock-XXXXXX", name[512];
    require(mkdtemp(root) != NULL, "temporary hierarchy");
    for (int i = 0; i < 2; i++) {
        path(name, sizeof name, root, i ? "deny" : "allow");
        require(mkdir(name, 0700) == 0, "hierarchy directory");
        path(name, sizeof name, root, i ? "deny/file" : "allow/file");
        int fd = open(name, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
        char c = i ? 'D' : 'A';
        require(fd >= 0 && write(fd, &c, 1) == 1 && close(fd) == 0, "hierarchy data");
    }
    path(name, sizeof name, root, "allow/outside");
    require(symlink("../deny/file", name) == 0, "hierarchy escape symlink");
    child("restrict", root);
    puts("landlock: standard ruleset errors, path policy and retained descriptor lifetime pass");
    child("exec", root);
    puts("landlock: independent child restrictions survive standard exec and descriptor close pass");
    require(unlink(name) == 0, "symlink cleanup");
    for (int i = 0; i < 2; i++) {
        path(name, sizeof name, root, i ? "deny/file" : "allow/file");
        int fd = open(name, O_RDWR | O_CLOEXEC);
        char c = 0;
        require(fd >= 0 && read(fd, &c, 1) == 1 && c == (i ? 'D' : 'A') &&
                write(fd, "P", 1) == 1 && close(fd) == 0, "parent remains unrestricted");
        require(unlink(name) == 0, "file cleanup");
        path(name, sizeof name, root, i ? "deny" : "allow");
        require(rmdir(name) == 0, "directory cleanup");
    }
    require(rmdir(root) == 0, "hierarchy cleanup");
    puts("landlock: parent policy isolation, single reaping and filesystem cleanup pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
