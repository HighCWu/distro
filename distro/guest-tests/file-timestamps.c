// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "file timestamps: %s errno=%d\n", what, errno);
    exit(1);
}
static void same(struct timespec actual, struct timespec expected)
{
    long delta = actual.tv_nsec - expected.tv_nsec;
    require(actual.tv_sec == expected.tv_sec && delta >= -1000 && delta <= 1000,
            "signed seconds and subsecond value");
}
static void check(int fd, const struct timespec expected[2])
{
    struct stat state;
    require(fstat(fd, &state) == 0, "stat open file");
    same(state.st_atim, expected[0]);
    same(state.st_mtim, expected[1]);
}
int main(int argc, char **argv)
{
    require(argc == 2, "expected existing writable file path");
    int fd = open(argv[1], O_RDWR | O_CLOEXEC);
    require(fd >= 0, "open timestamp fixture");
    struct timespec times[2] = { { -1, 250000000 }, { -1, 500000000 } };
    require(utimensat(AT_FDCWD, argv[1], times, 0) == 0, "utimensat before epoch");
    check(fd, times);
    struct stat path;
    require(stat(argv[1], &path) == 0, "stat timestamp path");
    same(path.st_atim, times[0]);
    same(path.st_mtim, times[1]);
    puts("file timestamps: utimensat preserves negative time64 seconds and fractions pass");

    times[0].tv_sec = times[1].tv_sec = -2;
    require(futimens(fd, times) == 0, "futimens before epoch");
    check(fd, times);
    struct timespec bad[2] = { times[0], { 99, 1000000000 } };
    errno = 0;
    require(futimens(fd, bad) == -1 && errno == EINVAL, "invalid nanoseconds rejected");
    check(fd, times);
    puts("file timestamps: futimens preserves negative seconds and invalid nanoseconds leave times unchanged pass");

    struct timespec update[2] = { { 0, UTIME_OMIT }, { 2, 987654000 } };
    require(futimens(fd, update) == 0, "retain atime and set positive mtime");
    times[1] = update[1];
    check(fd, times);
    require(close(fd) == 0, "close timestamp fixture");
    puts("file timestamps: UTIME_OMIT retains atime and later positive timestamp recovers pass");
    return 0;
}
