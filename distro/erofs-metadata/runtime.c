// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

static const unsigned char binary[] = {0, 1, 2, 0, 255, 127, 128};

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: erofs-metadata: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static void payload(const char *root)
{
    char path[512];
    int n = snprintf(path, sizeof path, "%s/payload", root);
    require(n > 0 && (size_t)n < sizeof path, "payload path");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open multi-page payload");
    struct stat st;
    require(fstat(fd, &st) == 0 && st.st_size == 131089, "payload size");
    unsigned char buffer[4093];
    size_t offset = 0;
    while (offset < 131089) {
        ssize_t got = pread(fd, buffer, sizeof buffer, (off_t)offset);
        if (got == -1 && errno == EINTR) continue;
        require(got > 0 && (size_t)got <= 131089 - offset, "bounded payload read");
        for (ssize_t i = 0; i < got; ++i) {
            size_t index = offset + (size_t)i;
            require(buffer[i] == (unsigned char)(index * 37 + (index >> 8)), "payload byte at page boundary");
        }
        offset += (size_t)got;
    }
    require(pread(fd, buffer, sizeof buffer, (off_t)offset) == 0 && close(fd) == 0,
            "payload EOF and descriptor cleanup");
}

static void attributes(const char *root)
{
    char path[512], link[512];
    int n = snprintf(path, sizeof path, "%s/file", root);
    require(n > 0 && (size_t)n < sizeof path, "file path");
    n = snprintf(link, sizeof link, "%s/link", root);
    require(n > 0 && (size_t)n < sizeof link, "symlink path");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open attributed file");
    unsigned char value[32];
    require(getxattr(path, "user.binary", NULL, 0) == sizeof binary &&
            fgetxattr(fd, "user.binary", value, sizeof value) == sizeof binary &&
            !memcmp(value, binary, sizeof binary), "binary attribute size and descriptor value");
    memset(value, 0, sizeof value);
    require(getxattr(link, "user.binary", value, sizeof value) == sizeof binary &&
            !memcmp(value, binary, sizeof binary), "symlink-following attribute lookup");
    require(lgetxattr(path, "user.empty", value, sizeof value) == 0,
            "empty attribute differs from missing attribute");
    require(getxattr(root, "user.directory", value, sizeof value) == 3 &&
            !memcmp(value, "dir", 3), "directory attribute");
    require(getxattr(root, "user.binary", value, sizeof value) == sizeof binary &&
            !memcmp(value, binary, sizeof binary) &&
            getxattr(root, "user.empty", value, sizeof value) == 0,
            "root inline/shared binary and empty attribute values");

    ssize_t count = listxattr(path, NULL, 0);
    require(count > 0 && count <= 4096, "discover bounded attribute names");
    char *names = malloc((size_t)count);
    require(names != NULL, "allocate name list");
    require(flistxattr(fd, names, (size_t)count) == count, "descriptor name list");
    int found_binary = 0, found_empty = 0;
    for (size_t offset = 0; offset < (size_t)count;) {
        size_t length = strnlen(names + offset, (size_t)count - offset);
        require(length > 0 && length < (size_t)count - offset, "terminated attribute names");
        found_binary += !strcmp(names + offset, "user.binary");
        found_empty += !strcmp(names + offset, "user.empty");
        offset += length + 1;
    }
    require(found_binary == 1 && found_empty == 1, "distinct expected attribute names");
    require(llistxattr(path, names, (size_t)count) == count, "non-following regular-file list");
    errno = 0;
    require(flistxattr(fd, names, 1) == -1 && errno == ERANGE, "short name list rejected");
    free(names);
    errno = 0;
    require(getxattr(path, "user.binary", value, sizeof binary - 1) == -1 && errno == ERANGE,
            "short binary buffer rejected");
    errno = 0;
    require(fgetxattr(fd, "user.missing", value, sizeof value) == -1 && errno == ENODATA,
            "missing attribute rejected");
    errno = 0;
    require(lgetxattr(link, "user.binary", value, sizeof value) == -1 && errno == ENODATA,
            "non-following lookup does not read symlink target");
    errno = 0;
    require(fgetxattr(-1, "user.binary", value, sizeof value) == -1 && errno == EBADF,
            "invalid descriptor rejected");
#ifdef __wasm__
    errno = 0;
    require(setxattr(path, "user.binary", "x", 1, 0) == -1 && errno == EROFS,
            "read-only attribute replacement rejected");
    errno = 0;
    require(fremovexattr(fd, "user.empty") == -1 && errno == EROFS,
            "read-only attribute removal rejected");
#endif
    require(fgetxattr(fd, "user.binary", value, sizeof value) == sizeof binary &&
            !memcmp(value, binary, sizeof binary), "errors preserve original attribute");
    require(close(fd) == 0, "close attributed file");
}

int main(int argc, char **argv)
{
#ifdef __wasm__
    (void)argc; (void)argv;
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devices");
    require(mkdir("/metadata", 0755) == 0, "create mount point");
    const char *devices[] = {"/dev/vda", "/dev/vdb"};
    for (unsigned i = 0; i < 2; ++i) {
        require(mount(devices[i], "/metadata", "erofs", MS_RDONLY, NULL) == 0, "mount attributed EROFS");
        struct statfs fs;
        require(statfs("/metadata", &fs) == 0 && fs.f_type == 0xe0f5e1e2UL,
                "actual EROFS filesystem");
        attributes("/metadata");
        payload("/metadata");
        puts(i ? "erofs-metadata: shared binary/empty/directory attributes, lists and errors pass" :
                 "erofs-metadata: inline binary/empty/directory attributes, lists and errors pass");
        require(umount("/metadata") == 0, "unmount without retained file references");
    }
    const char *images[] = {"/inline.erofs", "/shared.erofs"};
    errno = 0;
    require(mount("/invalid.erofs", "/metadata", "erofs", MS_RDONLY, NULL) == -1 && errno == EINVAL,
            "invalid regular image rejected before later valid mount");
    for (unsigned i = 0; i < 2; ++i) {
        require(mount(images[i], "/metadata", "erofs", MS_RDONLY, NULL) == 0,
                "mount regular image without a loop device");
        if (i == 0)
            require(rename(images[i], "/renamed.erofs") == 0 && unlink("/renamed.erofs") == 0,
                    "mounted file retains backing after source rename and unlink");
        attributes("/metadata");
        payload("/metadata");
        int held = open("/metadata/payload", O_RDONLY | O_CLOEXEC);
        require(held >= 0, "hold reference across busy unmount");
        errno = 0;
        require(umount("/metadata") == -1 && errno == EBUSY, "busy file-backed mount rejected");
        require(close(held) == 0, "release mount reference");
        require(umount("/metadata") == 0, "file-backed mount cleanup");
    }
    puts("erofs-metadata: regular-file image mounts, attributes and multi-page data pass");
    require(rmdir("/metadata") == 0 && umount("/dev") == 0, "mount cleanup");
    puts("erofs-metadata: read-only preservation and mount cleanup pass");
#else
    require(argc == 2, "native fixture directory argument");
    attributes(argv[1]);
    payload(argv[1]);
    puts("erofs-metadata: native attribute workload pass (not EROFS mount evidence)");
#endif
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
