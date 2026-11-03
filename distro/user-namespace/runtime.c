// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: user namespace: %s errno=%d\n", what, errno);
    exit(1);
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(!mkdir("/proc", 0555) || errno == EEXIST, "procfs mountpoint");
    require(!mount("proc", "/proc", "proc", 0, NULL), "procfs fixture mount");
    struct stat before, after;
    require(getuid() == 0 && getgid() == 0 && !stat("/proc/self/ns/user", &before),
            "initial root namespace");
    int groups = getgroups(0, NULL);
    require(groups >= 0, "initial groups");
    char *arguments[] = {"/userns-helper", NULL};
    char *environment[] = {NULL};
    pid_t child;
    require(posix_spawn(&child, arguments[0], NULL, NULL, arguments, environment) == 0,
            "ordinary helper spawn");
    int status;
    pid_t waited;
    do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
    require(waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
            "child policy and exec complete");
    errno = 0;
    require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
    require(!stat("/proc/self/ns/user", &after) && before.st_ino == after.st_ino &&
            getuid() == 0 && getgid() == 0 && getgroups(0, NULL) == groups,
            "parent namespace and groups unaffected");
    require(!umount("/proc"), "procfs fixture cleanup");
    puts("user namespace: parent namespace, groups, single reap and cleanup pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
