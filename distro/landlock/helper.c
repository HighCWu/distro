// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: landlock helper: %s errno=%d\n", what, errno);
    _Exit(1);
}

static void path(char *out, size_t size, const char *root, const char *suffix)
{
    int n = snprintf(out, size, "%s/%s", root, suffix);
    require(n > 0 && (size_t)n < size, "bounded path");
}

static void check_policy(const char *root)
{
    char name[512], c = 0;
    path(name, sizeof name, root, "allow/file");
    int fd = open(name, O_RDONLY | O_CLOEXEC);
    require(fd >= 0 && read(fd, &c, 1) == 1 && c == 'A' && close(fd) == 0,
            "allowed hierarchy read");
    errno = 0;
    require(open(name, O_WRONLY | O_CLOEXEC) == -1 && errno == EACCES,
            "read-only rule denies write");
    path(name, sizeof name, root, "deny/file");
    errno = 0;
    require(open(name, O_RDONLY | O_CLOEXEC) == -1 && errno == EACCES,
            "unlisted hierarchy denies read");
    errno = 0;
    require(open(name, O_WRONLY | O_CLOEXEC) == -1 && errno == EACCES,
            "unlisted hierarchy denies write");
    path(name, sizeof name, root, "allow/outside");
    errno = 0;
    require(open(name, O_RDONLY | O_CLOEXEC) == -1 && errno == EACCES,
            "allowed path symlink cannot escape into denied hierarchy");
    path(name, sizeof name, root, "allow");
    fd = open(name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(fd >= 0 && close(fd) == 0, "allowed directory read");
    path(name, sizeof name, root, "deny");
    errno = 0;
    require(open(name, O_RDONLY | O_DIRECTORY | O_CLOEXEC) == -1 && errno == EACCES,
            "unlisted directory denies read");
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--probe")) {
        long abi = syscall(SYS_landlock_create_ruleset, 0L, 0L,
                           (long)LANDLOCK_CREATE_RULESET_VERSION, 0L, 0L, 0L);
        return abi >= 1 ? 0 : 77;
    }
    require(argc == 3, "arguments");
    if (!strcmp(argv[1], "verify")) {
        check_policy(argv[2]);
        return 37;
    }
    require(!strcmp(argv[1], "restrict") || !strcmp(argv[1], "exec"), "mode");
    require(syscall(SYS_landlock_create_ruleset, 0L, 0L,
                    (long)LANDLOCK_CREATE_RULESET_VERSION, 0L, 0L, 0L) >= 1,
            "standard ABI version query");
    struct landlock_ruleset_attr attributes = {0};
    errno = 0;
    require(syscall(SYS_landlock_create_ruleset, (long)&attributes,
                    (long)sizeof attributes, 0L, 0L, 0L, 0L) == -1 && errno == ENOMSG,
            "empty handled access rejected");
    attributes.handled_access_fs = LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    errno = 0;
    require(syscall(SYS_landlock_create_ruleset, -1L, (long)sizeof attributes,
                    0L, 0L, 0L, 0L) == -1 && errno == EFAULT,
            "bad attributes address rejected");
    int ruleset = syscall(SYS_landlock_create_ruleset, (long)&attributes,
                          (long)sizeof attributes, 0L, 0L, 0L, 0L);
    require(ruleset >= 0, "ruleset creation after errors");
    struct landlock_path_beneath_attr rule = {
        .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR,
        .parent_fd = -1,
    };
    errno = 0;
    require(syscall(SYS_landlock_add_rule, (long)ruleset,
                    (long)LANDLOCK_RULE_PATH_BENEATH, (long)&rule, 0L, 0L, 0L) == -1 &&
            errno == EBADF, "invalid rule descriptor rejected");
    char name[512];
    path(name, sizeof name, argv[2], "allow");
    int directory = open(name, O_PATH | O_DIRECTORY | O_CLOEXEC);
    require(directory >= 0, "rule directory");
    rule.parent_fd = directory;
    require(syscall(SYS_landlock_add_rule, (long)ruleset,
                    (long)LANDLOCK_RULE_PATH_BENEATH, (long)&rule, 0L, 0L, 0L) == 0,
            "standard path-beneath rule after error");
    require(close(directory) == 0, "rule keeps path after original fd closes");
    directory = open(argv[0], O_PATH | O_CLOEXEC);
    require(directory >= 0, "executable rule descriptor");
    rule.parent_fd = directory;
    rule.allowed_access = LANDLOCK_ACCESS_FS_READ_FILE;
    require(syscall(SYS_landlock_add_rule, (long)ruleset,
                    (long)LANDLOCK_RULE_PATH_BENEATH, (long)&rule, 0L, 0L, 0L) == 0 &&
            close(directory) == 0, "read permission for static executable");
    path(name, sizeof name, argv[2], "deny/file");
    int retained = open(name, O_RDONLY | O_CLOEXEC);
    require(retained >= 0, "preopened descriptor");
    require(prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) == 0, "no-new-privileges");
    errno = 0;
    require(syscall(SYS_landlock_restrict_self, -1L, 0L, 0L, 0L, 0L, 0L) == -1 &&
            errno == EBADF, "invalid restrict descriptor rejected");
    require(syscall(SYS_landlock_restrict_self, (long)ruleset, 0L, 0L, 0L, 0L, 0L) == 0,
            "standard restriction after error");
    require(close(ruleset) == 0, "restriction outlives ruleset fd");
    check_policy(argv[2]);
    char c = 0;
    require(read(retained, &c, 1) == 1 && c == 'D' && close(retained) == 0,
            "restriction does not revoke preopened file");
    if (!strcmp(argv[1], "exec")) {
        char *args[] = {argv[0], "verify", argv[2], NULL};
        char *environment[] = {NULL};
        /* EXECUTE is deliberately unhandled; the new image must inherit the
         * existing read/write policy, without reopening rule descriptors. */
        execve(argv[0], args, environment);
        require(0, "exec restricted process");
    }
    return 37;
}
