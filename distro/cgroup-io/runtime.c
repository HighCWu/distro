// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define ROOT "/cgroup-io"
#define LEAF ROOT "/reader"

enum { READ_OFFSET = 128 * 1024, READ_SIZE = 16 * 1024 };
struct counters { uint64_t bytes, ios; };

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: cgroup io: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static void control(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t length = strlen(value);
    ssize_t count;
    do { count = write(fd, value, length); } while (count < 0 && errno == EINTR);
    require(count == (ssize_t)length && close(fd) == 0, "write complete cgroup control");
}

static void check_controller(void)
{
    FILE *file = fopen(ROOT "/cgroup.controllers", "r");
    require(file != NULL, "open cgroup.controllers");
    char controller[64];
    int found = 0;
    while (fscanf(file, "%63s", controller) == 1) {
        if (!strcmp(controller, "io")) found = 1;
    }
    require(!ferror(file) && fclose(file) == 0 && found, "root exposes the io controller");
}

static void check_membership(int expected)
{
    FILE *file = fopen(LEAF "/cgroup.procs", "r");
    require(file != NULL, "open leaf cgroup.procs");
    long pid;
    if (expected) {
        require(fscanf(file, "%ld", &pid) == 1 && pid == (long)getpid(),
                "current process is in the leaf");
    }
    require(fscanf(file, "%ld", &pid) == EOF && !ferror(file) && fclose(file) == 0,
            "no other processes in the leaf");
}

static struct counters read_io_stat(unsigned disk_major, unsigned disk_minor)
{
    FILE *file = fopen(LEAF "/io.stat", "r");
    require(file != NULL, "open leaf io.stat");
    struct counters result = {0};
    char line[512];
    int found = 0;
    while (fgets(line, sizeof(line), file)) {
        require(strchr(line, '\n') != NULL, "read a complete io.stat device line");
        unsigned dev_major, dev_minor;
        int first_field;
        require(sscanf(line, "%u:%u%n", &dev_major, &dev_minor, &first_field) == 2,
                "parse io.stat device number");
        if (dev_major != disk_major || dev_minor != disk_minor) continue;
        require(!found, "unique disk accounting line");
        found = 1;
        const char *fields = line + first_field;
        fields += strspn(fields, " \t\n");
        // Linux emits just the device number when its counters are all zero.
        if (*fields != '\0') {
            uint64_t written;
            require(sscanf(fields, "rbytes=%" SCNu64 " wbytes=%" SCNu64 " rios=%" SCNu64,
                    &result.bytes, &written, &result.ios) == 3, "read disk accounting fields");
        }
    }
    require(!ferror(file) && fclose(file) == 0, "close leaf io.stat");
    return result;
}

static void read_disk(int fd)
{
    unsigned char buffer[4096];
    size_t position = 0;
    while (position < READ_SIZE) {
        size_t remaining = READ_SIZE - position;
        size_t length = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
        ssize_t count = pread(fd, buffer, length, (off_t)(READ_OFFSET + position));
        if (count < 0 && errno == EINTR) continue;
        require(count > 0 && (size_t)count <= length, "read from the test disk");
        for (ssize_t i = 0; i < count; ++i) {
            size_t index = position + (size_t)i;
            require(buffer[i] == (unsigned char)((index * 31) ^ (index >> 5)),
                    "verify deterministic disk bytes");
        }
        position += (size_t)count;
    }
}

int main(void)
{
#ifndef __wasm__
    require(0, "run only in the isolated Linux/Wasm VM");
#endif
    require(getpid() == 1, "run as init in the isolated VM");
    require(mkdir(ROOT, 0755) == 0 && mount("none", ROOT, "cgroup2", 0, NULL) == 0,
            "mount a cgroup v2 hierarchy");
    check_controller();
    control(ROOT "/cgroup.subtree_control", "+io");
    require(mkdir(LEAF, 0755) == 0, "create leaf cgroup");
    control(LEAF "/cgroup.procs", "0");
    check_membership(1);

    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devtmpfs");
    int disk = open("/dev/vda", O_RDONLY | O_CLOEXEC);
    struct stat metadata;
    require(disk >= 0 && fstat(disk, &metadata) == 0 && S_ISBLK(metadata.st_mode),
            "open the read-only virtio block device");
    unsigned disk_major = major(metadata.st_rdev);
    unsigned disk_minor = minor(metadata.st_rdev);
    struct counters before = read_io_stat(disk_major, disk_minor);
    read_disk(disk);
    require(close(disk) == 0, "close disk");
    struct counters after = read_io_stat(disk_major, disk_minor);
    require(after.bytes > before.bytes && after.ios > before.ios,
            "actual disk reads raise leaf rbytes and rios");
    printf("cgroup io: device %u:%u leaf rbytes=%" PRIu64 " rios=%" PRIu64 " pass\n",
            disk_major, disk_minor, after.bytes - before.bytes, after.ios - before.ios);

    control(ROOT "/cgroup.procs", "0");
    check_membership(0);
    require(rmdir(LEAF) == 0, "remove the empty leaf");
    control(ROOT "/cgroup.subtree_control", "-io");
    require(umount(ROOT) == 0 && rmdir(ROOT) == 0 && umount("/dev") == 0,
            "unmount the hierarchy and device filesystem");
    puts("cgroup io: process migration and hierarchy cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
