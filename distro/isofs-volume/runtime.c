// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#define ROOT "/isofs"
#define LONG_NAME "Long ISO 文件名 spanning pages.bin"
enum { PAYLOAD_SIZE = 6 * 65536 + 173, BUFFER_SIZE = 8197 };

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: isofs volume: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static unsigned char expected_byte(size_t position)
{
    size_t in_page = position % 4096;
    uint64_t page = position / 4096;
    return in_page < 8 ? (unsigned char)(page >> (in_page * 8)) :
        (unsigned char)(in_page * 37 + (in_page >> 8) * 17);
}

static void verify_bytes(const unsigned char *buffer, size_t length, size_t start)
{
    for (size_t i = 0; i < length; ++i) {
        require(buffer[i] == expected_byte(start + i), "compare exact ISO payload bytes");
    }
}

static void pread_exact(int fd, unsigned char *buffer, size_t length, off_t offset)
{
    size_t read_bytes = 0;
    while (read_bytes < length) {
        ssize_t result = pread(fd, buffer + read_bytes, length - read_bytes,
                               offset + (off_t)read_bytes);
        if (result < 0 && errno == EINTR) continue;
        require(result > 0, "pread ISO payload");
        read_bytes += (size_t)result;
    }
}

static void verify_payload(int directory_fd)
{
    int fd = openat(directory_fd, LONG_NAME, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open Joliet Unicode filename");
    struct stat metadata;
    require(fstat(fd, &metadata) == 0 && metadata.st_size == (off_t)PAYLOAD_SIZE,
            "verify ISO payload size");

    unsigned char buffer[BUFFER_SIZE];
    size_t offset = 0;
    while (offset < PAYLOAD_SIZE) {
        size_t count = PAYLOAD_SIZE - offset;
        if (count > sizeof buffer) count = sizeof buffer;
        ssize_t result = read(fd, buffer, count);
        if (result < 0 && errno == EINTR) continue;
        require(result > 0 && (size_t)result <= count, "sequentially read ISO payload");
        verify_bytes(buffer, (size_t)result, offset);
        offset += (size_t)result;
    }
    require(read(fd, buffer, sizeof buffer) == 0, "read ISO payload EOF");

    const size_t positions[] = {
        65536 - 37,
        131072 - 71,
        262144 - 101,
        PAYLOAD_SIZE - 173,
    };
    require(lseek(fd, 12345, SEEK_SET) == 12345, "set ISO file cursor before pread");
    for (size_t i = 0; i < sizeof positions / sizeof positions[0]; ++i) {
        size_t count = PAYLOAD_SIZE - positions[i];
        if (count > sizeof buffer) count = sizeof buffer;
        pread_exact(fd, buffer, count, (off_t)positions[i]);
        verify_bytes(buffer, count, positions[i]);
        require(lseek(fd, 0, SEEK_CUR) == 12345, "pread preserves ISO file cursor");
    }
    require(pread(fd, buffer, sizeof buffer, PAYLOAD_SIZE) == 0, "pread ISO payload EOF");
    require(close(fd) == 0, "close ISO payload descriptor");
}

int main(void)
{
#ifndef __wasm__
    require(0, "run only in the isolated Linux/Wasm VM");
#endif
    require(getpid() == 1 && getuid() == 0 && geteuid() == 0, "isolated root test process");
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devtmpfs");
    require(mkdir(ROOT, 0755) == 0 &&
            mount("/dev/vda", ROOT, "iso9660", MS_RDONLY, "iocharset=utf8") == 0,
            "mount Joliet ISO read-only");
    puts("isofs volume: mounted ISO read-only");

    struct statfs filesystem;
    require(statfs(ROOT, &filesystem) == 0 && filesystem.f_type == 0x9660,
            "confirm ISO9660 filesystem magic");
    int directory_fd = open(ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(directory_fd >= 0, "open ISO root directory");
    verify_payload(directory_fd);
    puts("isofs volume: Unicode Joliet path and exact sequential/cross-page pread pass");

    errno = 0;
    int write_fd = openat(directory_fd, LONG_NAME, O_WRONLY | O_CLOEXEC);
    require(write_fd < 0 && errno == EROFS, "reject writes to read-only ISO with EROFS");
    puts("isofs volume: writes rejected with EROFS");

    require(close(directory_fd) == 0 && umount(ROOT) == 0,
            "close ISO descriptors and unmount media");
    require(rmdir(ROOT) == 0 && umount("/dev") == 0, "clean up mountpoints");
    puts("isofs volume: unmounted and descriptors closed");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
