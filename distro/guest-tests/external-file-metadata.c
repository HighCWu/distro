// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
    require(argc == 3, "expected shared file and directory paths");
    DIR *directory = opendir(argv[2]);
    struct stat old_child;
    require(directory != NULL, "open original directory");
    int directory_fd = dirfd(directory);
    require(directory_fd >= 0 && fstatat(directory_fd, "old-entry", &old_child, 0) == 0,
            "open original directory and cache child before host replacement");
    int host_removed_fd = openat(directory_fd, "host-empty", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(host_removed_fd >= 0, "open empty directory before host removal");
    DIR *host_removed = fdopendir(host_removed_fd);
    require(host_removed != NULL, "retain directory stream across host removal");
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
            close(fd) == 0, "replacement read and original descriptor cleanup");
    puts("external metadata: replacement metadata, read and cleanup remain independent pass");
    require(truncate(argv[1], 3) == 0 && fstat(current, &replacement) == 0 &&
            replacement.st_size == 3, "path truncate works while a read-only fd is held");
    errno = 0;
    require(ftruncate(current, 0) == -1 && errno == EINVAL,
            "explicit read-only fd cannot truncate");
    int writable = open(argv[1], O_WRONLY | O_CLOEXEC);
    require(writable >= 0 && pwrite(writable, "replacement", 11, 0) == 11 &&
            close(writable) == 0 && fstat(current, &replacement) == 0 &&
            replacement.st_size == 11 && close(current) == 0,
            "restore replacement data and close independent handles");
    puts("external metadata: path truncate with read-only fd, explicit EINVAL and write recovery pass");
    // The host removed this directory during the handshake. Linux has not
    // processed rmdir for it, so readdir must reach the filesystem backend.
    struct stat host_removed_stat;
    require(fstat(host_removed_fd, &host_removed_stat) == 0 && host_removed_stat.st_nlink == 0,
            "host-removed directory descriptor retains unlinked inode");
    errno = 0;
    require(readdir(host_removed) == NULL && errno == 0,
            "host-removed directory stream reaches clean EOF");
    require(closedir(host_removed) == 0, "close host-removed directory stream");
    unsigned entries = 0;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        require(!strcmp(entry->d_name, "old-entry"), "old directory must not enumerate replacement");
        entries++;
    }
    require(errno == 0 && entries == 1, "enumerate exactly one original child");
    int original = openat(directory_fd, "old-entry", O_RDONLY | O_CLOEXEC);
    char original_bytes[8];
    struct stat original_stat;
    require(original >= 0 && fstat(original, &original_stat) == 0 &&
            original_stat.st_ino == old_child.st_ino &&
            read(original, original_bytes, sizeof original_bytes) == sizeof original_bytes &&
            !memcmp(original_bytes, "original", sizeof original_bytes) && close(original) == 0,
            "relative open retains original child identity and data");
    int created = openat(directory_fd, "created", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(created >= 0 && close(created) == 0 &&
            renameat(directory_fd, "created", directory_fd, "renamed") == 0 &&
            unlinkat(directory_fd, "renamed", 0) == 0,
            "relative create rename and unlink");
    require(mkdirat(directory_fd, "empty", 0700) == 0, "create empty directory for removal");
    int empty_fd = openat(directory_fd, "empty", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(empty_fd >= 0, "open empty directory before removal");
    DIR *removed = fdopendir(empty_fd);
    require(removed != NULL && unlinkat(directory_fd, "empty", AT_REMOVEDIR) == 0,
            "hold removed empty directory stream");
    struct stat removed_stat;
    require(fstat(empty_fd, &removed_stat) == 0 && removed_stat.st_nlink == 0,
            "removed directory descriptor retains unlinked inode");
    errno = 0;
    require(readdir(removed) == NULL && errno == 0, "removed directory stream reaches clean EOF");
    require(closedir(removed) == 0 && closedir(directory) == 0,
            "close removed and renamed directory streams");
    puts("external metadata: moved directory enumeration, child identity and relative operations pass");
    return 0;
}
