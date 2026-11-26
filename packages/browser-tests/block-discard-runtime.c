// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <unistd.h>

enum {
    DiskBytes = 512 * 1024,
    RangeStart = 4096,
    RangeSize = 8192,
    WindowSize = 4096,
    WriteStart = RangeStart + RangeSize + WindowSize,
    BaseByte = 0xa5,
    WrittenByte = 0x6b,
};

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: block discard: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static void expect_bytes(int fd, off_t position, size_t remaining,
                         unsigned char expected, const char *stage)
{
    unsigned char buffer[WindowSize];
    while (remaining != 0) {
        size_t wanted = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
        ssize_t got = pread(fd, buffer, wanted, position);
        if (got < 0 && errno == EINTR) continue;
        require(got > 0 && (size_t)got <= wanted, stage);
        for (ssize_t i = 0; i < got; ++i) {
            require(buffer[i] == expected, stage);
        }
        position += got;
        remaining -= (size_t)got;
    }
}

int main(void)
{
    require(getpid() == 1, "run as init in the test VM");
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devtmpfs");
    require(mount("sysfs", "/sys", "sysfs", 0, NULL) == 0, "mount sysfs");

    FILE *limit = fopen("/sys/block/vda/queue/discard_max_bytes", "r");
    require(limit != NULL, "open discard queue limit");
    unsigned long long discard_max = 0;
    require(fscanf(limit, "%llu", &discard_max) == 1 && discard_max > 0,
            "kernel reports a positive discard queue limit");
    require(fclose(limit) == 0, "close discard queue limit");

    int fd = open("/dev/vda", O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open test disk read-only");
    uint64_t disk_size = 0;
    require(ioctl(fd, BLKGETSIZE64, &disk_size) == 0 && disk_size == DiskBytes,
            "verify the test disk capacity");
    unsigned char first = 0;
    require(pread(fd, &first, sizeof(first), RangeStart) == sizeof(first), "read range state");
    require(first == WrittenByte || first == 0, "recognize prepared or discarded range");
    expect_bytes(fd, RangeStart - WindowSize, WindowSize, BaseByte, "verify preceding window");
    expect_bytes(fd, RangeStart, RangeSize, first, "verify the entire initial range");
    expect_bytes(fd, RangeStart + RangeSize, WindowSize, BaseByte, "verify following window");

    if (first == WrittenByte) {
        require(close(fd) == 0, "close read-only test disk");
        fd = open("/dev/vda", O_RDWR | O_CLOEXEC);
        require(fd >= 0, "open disposable test disk read/write");
        uint64_t range[2] = {RangeStart, RangeSize};
        require(ioctl(fd, BLKDISCARD, range) == 0, "issue BLKDISCARD");
        require(fsync(fd) == 0, "flush discarded range");
        expect_bytes(fd, RangeStart - WindowSize, WindowSize, BaseByte, "preserve preceding window");
        expect_bytes(fd, RangeStart, RangeSize, 0, "verify discarded range is zero");
        expect_bytes(fd, RangeStart + RangeSize, WindowSize, BaseByte, "preserve following window");

        unsigned char zeros[WindowSize] = {0};
        expect_bytes(fd, WriteStart, WindowSize, BaseByte, "verify ordinary write seed");
        require(pwrite(fd, zeros, sizeof(zeros), WriteStart) == sizeof(zeros),
                "write zeros through ordinary block I/O");
        require(fsync(fd) == 0, "flush ordinary zero write");
    }
    expect_bytes(fd, WriteStart, WindowSize, 0, "verify ordinary zero write");

    require(close(fd) == 0, "close test disk");
    require(umount("/sys") == 0, "unmount sysfs");
    require(umount("/dev") == 0, "unmount devtmpfs");
    puts(first == WrittenByte ?
            "block discard: issued BLKDISCARD and verified bytes" :
            "block discard: reopened disk retains discarded bytes");
    puts(first == WrittenByte ?
            "block zero write: flushed ordinary pwrite of zeros" :
            "block zero write: reopened disk retains ordinary zero write");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
