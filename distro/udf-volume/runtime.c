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

#define ROOT "/udf"
#define FILE_NAME "UDF payload crossing pages.bin"
enum { PAYLOAD_SIZE = 6 * 65536 + 173, BUFFER_SIZE = 8197 };

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: UDF volume: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static unsigned char expected_byte(size_t position)
{
    return (unsigned char)(position * 37 + position / 4096);
}

static void verify_bytes(const unsigned char *buffer, size_t length, size_t start)
{
    for (size_t i = 0; i < length; ++i) {
        require(buffer[i] == expected_byte(start + i), "compare exact UDF payload bytes");
    }
}

static void pread_exact(int fd, unsigned char *buffer, size_t length, off_t offset)
{
    size_t read_bytes = 0;
    while (read_bytes < length) {
        ssize_t result = pread(fd, buffer + read_bytes, length - read_bytes,
                               offset + (off_t)read_bytes);
        if (result < 0 && errno == EINTR) continue;
        require(result > 0, "pread UDF payload");
        read_bytes += (size_t)result;
    }
}

static void verify_payload(int directory_fd)
{
    int fd = openat(directory_fd, FILE_NAME, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open UDF payload file");
    struct stat metadata;
    require(fstat(fd, &metadata) == 0 && metadata.st_size == (off_t)PAYLOAD_SIZE,
            "verify UDF payload size");

    unsigned char buffer[BUFFER_SIZE];
    size_t offset = 0;
    while (offset < PAYLOAD_SIZE) {
        size_t count = PAYLOAD_SIZE - offset;
        if (count > sizeof buffer) count = sizeof buffer;
        ssize_t result = read(fd, buffer, count);
        if (result < 0 && errno == EINTR) continue;
        require(result > 0 && (size_t)result <= count, "sequentially read UDF payload");
        verify_bytes(buffer, (size_t)result, offset);
        offset += (size_t)result;
    }
    require(read(fd, buffer, sizeof buffer) == 0, "read UDF payload EOF");

    const size_t positions[] = {
        65536 - 37,
        131072 - 71,
        262144 - 101,
        PAYLOAD_SIZE - 173,
    };
    require(lseek(fd, 12345, SEEK_SET) == 12345, "set UDF file cursor before pread");
    for (size_t i = 0; i < sizeof positions / sizeof positions[0]; ++i) {
        size_t count = PAYLOAD_SIZE - positions[i];
        if (count > sizeof buffer) count = sizeof buffer;
        pread_exact(fd, buffer, count, (off_t)positions[i]);
        verify_bytes(buffer, count, positions[i]);
        require(lseek(fd, 0, SEEK_CUR) == 12345, "pread preserves UDF file cursor");
    }
    require(pread(fd, buffer, sizeof buffer, PAYLOAD_SIZE) == 0, "pread UDF payload EOF");
    require(close(fd) == 0, "close UDF payload descriptor");
}

int main(void)
{
#ifndef __wasm__
    require(0, "run only in the isolated Linux/Wasm VM");
#endif
    require(getpid() == 1 && getuid() == 0 && geteuid() == 0, "isolated root test process");
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devtmpfs");
    require(mkdir(ROOT, 0755) == 0 &&
            mount("/dev/vda", ROOT, "udf", MS_RDONLY, NULL) == 0,
            "mount UDF optical volume read-only");
    puts("UDF volume: mounted read-only");

    struct statfs filesystem;
    require(statfs(ROOT, &filesystem) == 0 && filesystem.f_type == 0x15013346,
            "confirm UDF filesystem magic");
    int directory_fd = open(ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(directory_fd >= 0, "open UDF root directory");
    verify_payload(directory_fd);
    puts("UDF volume: exact sequential/cross-page pread data and EOF pass");

    errno = 0;
    int write_fd = openat(directory_fd, FILE_NAME, O_WRONLY | O_CLOEXEC);
    require(write_fd < 0 && errno == EROFS, "reject writes to read-only UDF with EROFS");
    puts("UDF volume: writes rejected with EROFS");

    require(close(directory_fd) == 0 && umount(ROOT) == 0,
            "close UDF descriptors and unmount optical volume");
    require(rmdir(ROOT) == 0 && umount("/dev") == 0, "clean up mountpoints");
    puts("UDF volume: unmounted and descriptors closed");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
