// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "creation modes: %s errno=%d\n", what, errno);
    exit(1);
}
static void mode(const char *path, mode_t expected)
{
    struct stat state;
    require(stat(path, &state) == 0 && (state.st_mode & 0777) == expected, "exact caller creation permissions");
}
int main(int argc, char **argv)
{
    require(argc == 2, "expected writable directory");
    char file[PATH_MAX], directory[PATH_MAX];
    require(snprintf(file, sizeof file, "%s/create-mode-file", argv[1]) < (int)sizeof file &&
            snprintf(directory, sizeof directory, "%s/create-mode-directory", argv[1]) < (int)sizeof directory,
            "bounded fixture paths");
    mode_t original = umask(0);
    int fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0666);
    require(fd >= 0 && close(fd) == 0 && mkdir(directory, 0777) == 0, "unmasked file and directory creation");
    mode(file, 0666); mode(directory, 0777);
    puts("creation modes: zero Linux umask retains requested file and directory permissions pass");

    require(chmod(file, 0640) == 0, "set existing file permissions");
    fd = open(file, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0777);
    require(fd >= 0 && write(fd, "new", 3) == 3 && close(fd) == 0, "nonexclusive create opens existing file");
    mode(file, 0640);
    errno = 0;
    fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0777);
    require(fd == -1 && errno == EEXIST, "exclusive creation rejects existing file");
    mode(file, 0640);
    puts("creation modes: existing O_CREAT preserves mode and exclusive collision changes nothing pass");

    require(unlink(file) == 0 && rmdir(directory) == 0, "remove first fixtures");
    umask(0027);
    fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0666);
    require(fd >= 0 && close(fd) == 0 && mkdir(directory, 0777) == 0, "masked creation");
    mode(file, 0640); mode(directory, 0750);
    require(unlink(file) == 0 && rmdir(directory) == 0, "release final fixtures");
    umask(original);
    puts("creation modes: Linux umask still removes requested permissions and cleanup recovers pass");

    umask(0027);
    require(mknod(file, S_IFREG | 0666, 0) == 0, "create regular file without opening it");
    struct stat created;
    require(stat(file, &created) == 0 && S_ISREG(created.st_mode) && created.st_size == 0,
            "mknod creates an empty regular inode");
    mode(file, 0640);
    fd = open(file, O_WRONLY | O_CLOEXEC);
    require(fd >= 0 && write(fd, "kept", 4) == 4 && close(fd) == 0, "write regular mknod file");
    errno = 0;
    require(mknod(file, S_IFREG | 0600, 0) == -1 && errno == EEXIST, "mknod rejects an existing name");
    struct stat retained;
    require(stat(file, &retained) == 0 && retained.st_ino == created.st_ino &&
            retained.st_size == 4 && (retained.st_mode & 0777) == 0640,
            "mknod collision preserves the inode, size and permissions");
    require(unlink(file) == 0, "remove mknod file");
    umask(original);
    puts("creation modes: regular mknod preserves mode and rejects replacement pass");
    return 0;
}
