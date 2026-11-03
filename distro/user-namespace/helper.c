// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: user namespace: %s errno=%d\n", what, errno);
    exit(1);
}

static void write_control(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    size_t size = strlen(value);
    require(fd >= 0 && write(fd, value, size) == (ssize_t)size && close(fd) == 0,
            "write proc mapping control");
}

static void check_mapping(const char *path)
{
    char text[128];
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open mapping");
    ssize_t size = read(fd, text, sizeof text - 1);
    require(size > 0 && size < (ssize_t)sizeof text && close(fd) == 0, "read mapping");
    text[size] = 0;
    unsigned long inside, outside, count;
    require(sscanf(text, "%lu %lu %lu", &inside, &outside, &count) == 3 &&
            inside == 0 && outside == 0 && count == 1, "exact single-id mapping");
}

static void check_policy(void)
{
    require(getuid() == 0 && geteuid() == 0 && getgid() == 0 && getegid() == 0,
            "mapped credentials");
    check_mapping("/proc/self/uid_map");
    check_mapping("/proc/self/gid_map");
    errno = 0;
    require(setgroups(0, NULL) == -1 && errno == EPERM, "deny remains effective for setgroups");
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(argc == 1 || (argc == 3 && !strcmp(argv[1], "after-exec")), "arguments");
    if (argc == 3) {
        char *end;
        unsigned long long expected = strtoull(argv[2], &end, 10);
        struct stat status;
        require(expected && !*end && !stat("/proc/self/ns/user", &status) &&
                (unsigned long long)status.st_ino == expected, "namespace identity across exec");
        check_policy();
        puts("user namespace: credentials and mapping policy survive ordinary exec pass");
        return 37;
    }
    int original = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
    struct stat before, after;
    require(original >= 0 && !fstat(original, &before), "original namespace descriptor");
    require(unshare(CLONE_NEWUSER) == 0, "standard unshare NEWUSER");
    require(!stat("/proc/self/ns/user", &after) && before.st_ino != after.st_ino,
            "distinct namespace identity");
    write_control("/proc/self/setgroups", "deny\n");
    write_control("/proc/self/uid_map", "0 0 1\n");
    write_control("/proc/self/gid_map", "0 0 1\n");
    check_policy();
    puts("user namespace: standard unshare, uid/gid maps and setgroups policy pass");

    int mapping = open("/proc/self/uid_map", O_WRONLY | O_CLOEXEC);
    require(mapping >= 0, "reopen mapping");
    errno = 0;
    require(write(mapping, "0 0 1\n", 6) == -1 && errno == EPERM && !close(mapping),
            "mapping cannot be rewritten");
    errno = 0;
    require(setuid(1) == -1 && errno == EINVAL && getuid() == 0, "unmapped uid refusal");
    int own = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
    require(own >= 0, "current namespace descriptor");
    errno = 0;
    require(setns(own, CLONE_NEWUSER) == -1 && errno == EINVAL, "same namespace reentry refusal");
    errno = 0;
    require(setns(original, CLONE_NEWUSER) == -1 && errno == EPERM, "ancestor namespace privilege refusal");
    require(!close(own) && !close(original), "namespace descriptor cleanup");
    puts("user namespace: mapping rewrite, unmapped ids and namespace reentry refusals pass");

    char number[32];
    int length = snprintf(number, sizeof number, "%llu", (unsigned long long)after.st_ino);
    require(length > 0 && length < (int)sizeof number, "namespace number");
    char *arguments[] = {argv[0], "after-exec", number, NULL};
    char *environment[] = {NULL};
    execve(argv[0], arguments, environment);
    require(0, "ordinary exec");
    return 1;
}
