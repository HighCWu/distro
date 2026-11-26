// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { PAYLOAD_SIZE = 4 * 65536 + 257 };
static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: initramfs-zstd: %s errno=%d\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static void check_bytes(const unsigned char *bytes, size_t length, size_t start)
{
    for (size_t i = 0; i < length; ++i) {
        size_t at = start + i;
        unsigned char expected = (unsigned char)(at * 37 + (at >> 8) * 13 + (at >> 16) * 7);
        require(bytes[i] == expected, "exact decompressed multi-page byte");
    }
}

static void check(const char *root)
{
    char path[512];
    int n = snprintf(path, sizeof path, "%s/payload.bin", root);
    require(n > 0 && (size_t)n < sizeof path, "payload path");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open extracted payload");
    struct stat metadata;
    require(fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
            metadata.st_size == PAYLOAD_SIZE && (metadata.st_mode & 0777) == 0640,
            "payload type, size and permissions");
#ifdef __wasm__
    require(metadata.st_uid == 0 && metadata.st_gid == 0, "newc archive root ownership");
#endif
    unsigned char bytes[5003];
    size_t offset = 0;
    while (offset < PAYLOAD_SIZE) {
        ssize_t got = read(fd, bytes, sizeof bytes);
        if (got == -1 && errno == EINTR) continue;
        require(got > 0 && (size_t)got <= PAYLOAD_SIZE - offset, "bounded sequential payload read");
        check_bytes(bytes, (size_t)got, offset);
        offset += (size_t)got;
    }
    require(read(fd, bytes, sizeof bytes) == 0, "payload EOF");
    require(pread(fd, bytes, sizeof bytes, 65536 - 37) == sizeof bytes, "pread crosses 64KiB page");
    check_bytes(bytes, sizeof bytes, 65536 - 37);
    require(pread(fd, bytes, sizeof bytes, PAYLOAD_SIZE - 257) == 257, "partial tail page");
    check_bytes(bytes, 257, PAYLOAD_SIZE - 257);
    require(close(fd) == 0, "close payload");

    n = snprintf(path, sizeof path, "%s/link", root);
    require(n > 0 && (size_t)n < sizeof path, "link path");
    require(lstat(path, &metadata) == 0 && S_ISLNK(metadata.st_mode), "archive preserves symlink type");
    char target[32];
    require(readlink(path, target, sizeof target) == 11 && !memcmp(target, "payload.bin", 11), "exact link text");
    require(stat(path, &metadata) == 0 && S_ISREG(metadata.st_mode) && metadata.st_size == PAYLOAD_SIZE,
            "symlink resolves to extracted payload");
    n = snprintf(path, sizeof path, "%s/executable", root);
    require(n > 0 && (size_t)n < sizeof path, "executable path");
    require(stat(path, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
            (metadata.st_mode & 0777) == 0751, "executable permissions");
    n = snprintf(path, sizeof path, "%s/empty", root);
    require(n > 0 && (size_t)n < sizeof path, "directory path");
    require(stat(path, &metadata) == 0 && S_ISDIR(metadata.st_mode) &&
            (metadata.st_mode & 0777) == 0750, "empty directory permissions");
    DIR *directory = opendir(path);
    require(directory != NULL, "open empty directory");
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL)
        require(!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."), "directory remains empty");
    require(errno == 0 && closedir(directory) == 0, "directory EOF and cleanup");
}

int main(int argc, char **argv)
{
#ifdef __wasm__
    (void)argc; (void)argv;
    check("/zstd-fixture");
    puts("initramfs-zstd: Linux decoded archive, multi-page bytes and metadata pass");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
#else
    require(argc == 2, "native fixture directory argument");
    check(argv[1]);
    puts("initramfs-zstd: native reference workload pass (not compressed boot evidence)");
    return 0;
#endif
}
