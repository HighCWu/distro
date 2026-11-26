// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

enum { PAYLOAD_SIZE = 6 * 65536 + 173, BUFFER_SIZE = 8197 };

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: erofs-compressed: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static void bytes_at(const unsigned char *buffer, size_t length, size_t start)
{
    for (size_t i = 0; i < length; ++i) {
        size_t at = (start + i) % 4096;
        uint64_t block = (start + i) / 4096;
        unsigned char expected = at < 8 ? (unsigned char)(block >> (at * 8)) :
            (unsigned char)(at * 37 + (at >> 8) * 17);
        require(buffer[i] == expected, "exact decompressed byte");
    }
}

static void payload(const char *root)
{
    char path[256];
    int n = snprintf(path, sizeof path, "%s/payload", root);
    require(n > 0 && (size_t)n < sizeof path, "payload path");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open compressed payload");
    struct stat st;
    require(fstat(fd, &st) == 0 && st.st_size == PAYLOAD_SIZE, "uncompressed payload size");
    unsigned char buffer[BUFFER_SIZE];
    size_t offset = 0;
    while (offset < PAYLOAD_SIZE) {
        ssize_t got = read(fd, buffer, sizeof buffer);
        if (got < 0 && errno == EINTR) continue;
        require(got > 0 && (size_t)got <= PAYLOAD_SIZE - offset, "sequential decompressed read");
        bytes_at(buffer, (size_t)got, offset);
        offset += (size_t)got;
    }
    require(read(fd, buffer, sizeof buffer) == 0, "sequential EOF");
    const size_t positions[] = {65536 - 37, 131072 - 71, 262144 - 101, PAYLOAD_SIZE - 173};
    require(lseek(fd, 12345, SEEK_SET) == 12345, "set preserved cursor");
    for (unsigned i = 0; i < sizeof positions / sizeof positions[0]; ++i) {
        size_t expected = PAYLOAD_SIZE - positions[i];
        if (expected > sizeof buffer) expected = sizeof buffer;
        ssize_t got = pread(fd, buffer, sizeof buffer, (off_t)positions[i]);
        require(got == (ssize_t)expected, "cross-page or tail pread length");
        bytes_at(buffer, expected, positions[i]);
        require(lseek(fd, 0, SEEK_CUR) == 12345, "pread preserves cursor");
    }
    uint32_t random = 0x12345678;
    for (unsigned i = 0; i < 17; ++i) {
        random = random * 1664525u + 1013904223u;
        size_t start = random % PAYLOAD_SIZE;
        size_t expected = PAYLOAD_SIZE - start;
        if (expected > sizeof buffer) expected = sizeof buffer;
        require(lseek(fd, (off_t)start, SEEK_SET) == (off_t)start, "random compressed seek");
        ssize_t got = read(fd, buffer, sizeof buffer);
        require(got == (ssize_t)expected, "random read length");
        bytes_at(buffer, expected, start);
    }
    require(pread(fd, buffer, sizeof buffer, PAYLOAD_SIZE) == 0, "tail EOF");
    require(close(fd) == 0, "release compressed payload descriptor");
}

int main(int argc, char **argv)
{
#ifdef __wasm__
    (void)argc; (void)argv;
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devices");
    require(mkdir("/compressed", 0755) == 0, "create compressed mountpoint");
    const char *sources[] = {"/dev/vda", "/compressed.erofs"};
    for (unsigned i = 0; i < 2; ++i) {
        require(mount(sources[i], "/compressed", "erofs", MS_RDONLY, NULL) == 0, "mount LZ4 EROFS");
        struct statfs fs;
        require(statfs("/compressed", &fs) == 0 && fs.f_type == 0xe0f5e1e2UL, "actual EROFS mount");
        payload("/compressed");
        puts(i ? "erofs-compressed: file-backed cross-page read, pread, random cursors and tail pass" :
                 "erofs-compressed: block-backed cross-page read, pread, random cursors and tail pass");
        require(umount("/compressed") == 0, "unmount compressed image");
    }
    require(rmdir("/compressed") == 0 && umount("/dev") == 0, "compressed mount cleanup");
    puts("erofs-compressed: mount cleanup pass");
#else
    require(argc == 2, "native extracted fixture directory argument");
    payload(argv[1]);
    puts("erofs-compressed: native extracted byte workload pass (not Linux EROFS mount evidence)");
#endif
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
