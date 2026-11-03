// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "open metadata: %s errno=%d\n", what, errno);
    exit(1);
}
static void content(int fd, const char *expected)
{
    char buffer[4] = {0};
    require(pread(fd, buffer, 3, 0) == 3 && !memcmp(buffer, expected, 3), "exact inode data");
}
int main(int argc, char **argv)
{
    require(argc == 2, "expected existing file path");
    int held = open(argv[1], O_RDONLY | O_CLOEXEC);
    struct stat before, old, replacement;
    require(held >= 0 && fstat(held, &before) == 0, "open original read-only descriptor");
    require(unlink(argv[1]) == 0, "unlink original file");
    int fresh = open(argv[1], O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    require(fresh >= 0 && write(fresh, "new", 3) == 3 && fchmod(fresh, 0644) == 0,
            "create independent replacement");
    require(fchmod(held, 0600) == 0 && fstat(held, &old) == 0,
            "fchmod an unlinked inode through read-only descriptor");
    require(old.st_ino == before.st_ino && old.st_dev == before.st_dev &&
            old.st_nlink == 0 && (old.st_mode & 0777) == 0600,
            "old inode identity and mode survive unlink");
    require(fstat(fresh, &replacement) == 0 && replacement.st_ino != old.st_ino &&
            replacement.st_nlink == 1 && (replacement.st_mode & 0777) == 0644,
            "same-name replacement mode and inode stay separate");
    puts("open metadata: fchmod updates unlinked inode and leaves same-name replacement unchanged pass");

    require(fchown(held, before.st_uid, before.st_gid) == 0 && fstat(held, &old) == 0 &&
            old.st_uid == before.st_uid && old.st_gid == before.st_gid,
            "fchown preserves original owner on unlinked inode");
    struct timespec times[2] = { { 4, 250000000 }, { 5, 500000000 } };
    require(futimens(held, times) == 0 && fstat(held, &old) == 0 &&
            old.st_atim.tv_sec == 4 && old.st_atim.tv_nsec == 250000000 &&
            old.st_mtim.tv_sec == 5 && old.st_mtim.tv_nsec == 500000000,
            "descriptor timestamps still apply to old inode");
    content(held, "old"); content(fresh, "new");
    puts("open metadata: owner and timestamp operations retain old inode and independent data pass");

    require(close(held) == 0, "close old descriptor");
    errno = 0;
    require(fchmod(held, 0600) == -1 && errno == EBADF, "closed descriptor rejected");
    require(fstat(fresh, &replacement) == 0 && (replacement.st_mode & 0777) == 0644,
            "closed-descriptor failure does not alter replacement");
    require(close(fresh) == 0, "close replacement");
    puts("open metadata: closed descriptor fails and replacement remains usable pass");
    return 0;
}
