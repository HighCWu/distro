// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "external metadata: %s errno=%d\n", what, errno);
    exit(1);
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(argc == 2, "expected shared file path");
    int fd = open(argv[1], O_RDONLY | O_CLOEXEC);
    struct stat before, held, replacement;
    require(fd >= 0 && fstat(fd, &before) == 0, "open and capture original inode");
    puts("external metadata: ready for host replacement");
    char go;
    require(read(STDIN_FILENO, &go, 1) == 1 && go == 'x', "replacement completed handshake");
    // Do not stat/open the pathname until the old descriptor's metadata has
    // been checked and changed: that lookup could conceal the stale-node bug.
    require(fstat(fd, &held) == 0 && held.st_ino == before.st_ino &&
            held.st_nlink == 0 && held.st_size == 3,
            "fstat retains old inode before any replacement lookup");
    puts("external metadata: fstat retains replaced open inode without fresh pathname lookup pass");
    const struct timespec times[2] = {{.tv_sec = 123}, {.tv_sec = 456}};
    require(fchmod(fd, 0600) == 0 && futimens(fd, times) == 0 && fstat(fd, &held) == 0 &&
            (held.st_mode & 0777) == 0600 && held.st_mtim.tv_sec == 456,
            "descriptor mode and timestamps stay on original inode");
    char bytes[3];
    require(read(fd, bytes, sizeof bytes) == 3 && bytes[0] == 'o' && bytes[1] == 'l' && bytes[2] == 'd',
            "original descriptor data survives replacement");
    puts("external metadata: mode, timestamps and data stay on original descriptor pass");
    require(stat(argv[1], &replacement) == 0 && replacement.st_ino != before.st_ino &&
            replacement.st_size == 11 && (replacement.st_mode & 0777) == 0640 &&
            replacement.st_mtim.tv_sec != 456,
            "replacement metadata remains independent");
    int current = open(argv[1], O_RDONLY | O_CLOEXEC);
    require(current >= 0 && read(current, bytes, sizeof bytes) == 3 &&
            bytes[0] == 'r' && bytes[1] == 'e' && bytes[2] == 'p' &&
            close(current) == 0 && close(fd) == 0, "replacement read and descriptor cleanup");
    puts("external metadata: replacement metadata, read and cleanup remain independent pass");
    return 0;
}
