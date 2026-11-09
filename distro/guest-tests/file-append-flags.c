// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { path_capacity = 4096 };

static void fail(const char *what)
{
    int saved_errno = errno;
    fprintf(stderr, "append flags: %s (errno=%d)\n", what, saved_errno);
    exit(1);
}

static void require(int condition, const char *what)
{
    if (!condition)
        fail(what);
}

static void make_path(char path[path_capacity], const char *directory,
                      const char *name)
{
    int length = snprintf(path, path_capacity, "%s/%s", directory, name);
    if (length < 0 || length >= path_capacity)
        fail("path is too long");
}

static void write_all(int fd, const void *buffer, size_t size)
{
    const unsigned char *bytes = buffer;
    size_t written = 0;
    while (written < size) {
        ssize_t result = write(fd, bytes + written, size - written);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            fail("write did not complete");
        written += (size_t)result;
    }
}

static void check_append_flag(int fd, int expected)
{
    int flags = fcntl(fd, F_GETFL);
    if (flags == -1)
        fail("F_GETFL failed");
    require(!!(flags & O_APPEND) == expected, "F_GETFL returned the wrong O_APPEND state");
}

static void set_append_flag(int fd, int flags, int enabled)
{
    int updated = enabled ? flags | O_APPEND : flags & ~O_APPEND;
    if (fcntl(fd, F_SETFL, updated) == -1)
        fail("F_SETFL failed");
    check_append_flag(fd, enabled);
}

static void check_descriptor(int fd, const char *expected, size_t size)
{
    struct stat info;
    char contents[64];
    size_t read_total = 0;

    require(size <= sizeof(contents), "test content exceeds the read buffer");
    if (fstat(fd, &info) == -1)
        fail("fstat failed");
    require(info.st_size == (off_t)size, "descriptor file size is incorrect");
    while (read_total < size) {
        ssize_t result = pread(fd, contents + read_total, size - read_total,
                               (off_t)read_total);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            fail("pread did not read the complete descriptor");
        read_total += (size_t)result;
    }
    require(memcmp(contents, expected, size) == 0, "descriptor contents are incorrect");
}

static void check_path(const char *path, const char *expected, size_t size)
{
    int fd = open(path, O_RDONLY);
    if (fd == -1)
        fail("open recreated path failed");
    check_descriptor(fd, expected, size);
    if (close(fd) == -1)
        fail("close recreated path failed");
}

static void stage_toggle(const char *path)
{
    static const char initial[] = "abcdef";
    static const char first_write[] = "aXcdef";
    static const char append_write[] = "aXcdefY";
    static const char final_write[] = "aXcZefY";
    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (fd == -1)
        fail("create toggle file failed");
    write_all(fd, initial, sizeof(initial) - 1);
    if (fsync(fd) == -1)
        fail("sync initial toggle file failed");
    if (close(fd) == -1)
        fail("close initial toggle file failed");

    fd = open(path, O_RDWR | O_APPEND);
    if (fd == -1)
        fail("reopen toggle file with O_APPEND failed");
    int append_flags = fcntl(fd, F_GETFL);
    if (append_flags == -1)
        fail("initial F_GETFL failed");
    require(append_flags & O_APPEND, "reopened descriptor lacks O_APPEND");

    set_append_flag(fd, append_flags, 0);
    require(lseek(fd, 1, SEEK_SET) == 1, "seek before clearing O_APPEND failed");
    write_all(fd, "X", 1);
    require(lseek(fd, 0, SEEK_CUR) == 2, "write after clearing O_APPEND used the wrong offset");
    check_descriptor(fd, first_write, sizeof(first_write) - 1);

    set_append_flag(fd, append_flags, 1);
    require(lseek(fd, 0, SEEK_SET) == 0, "seek before restoring O_APPEND failed");
    write_all(fd, "Y", 1);
    require(lseek(fd, 0, SEEK_CUR) == 7, "append after restoring O_APPEND used the wrong offset");
    check_descriptor(fd, append_write, sizeof(append_write) - 1);

    int current_flags = fcntl(fd, F_GETFL);
    if (current_flags == -1)
        fail("F_GETFL before second clear failed");
    set_append_flag(fd, current_flags, 0);
    require(lseek(fd, 3, SEEK_SET) == 3, "seek before second O_APPEND clear failed");
    write_all(fd, "Z", 1);
    require(lseek(fd, 0, SEEK_CUR) == 4, "write after second O_APPEND clear used the wrong offset");
    check_descriptor(fd, final_write, sizeof(final_write) - 1);
    if (fsync(fd) == -1)
        fail("sync toggle file failed");
    if (close(fd) == -1)
        fail("close toggle file failed");
}

static void await_host_replacement(void)
{
    static const char ready[] = "append flags: ready for host replacement\n";
    char byte;
    ssize_t result;

    write_all(STDOUT_FILENO, ready, sizeof(ready) - 1);
    do {
        result = read(STDIN_FILENO, &byte, 1);
    } while (result == -1 && errno == EINTR);
    if (result != 1)
        fail("host replacement handshake ended before its byte");
    require(byte == 'x', "host replacement handshake byte was not x");
}

static void stage_held_descriptor(const char *path)
{
    static const char initial[] = "original";
    static const char after_clear[] = "oBiginal";
    static const char after_append[] = "oBiginalC";
    struct stat before;
    struct stat after;
    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR | O_APPEND, 0600);
    if (fd == -1)
        fail("create held file failed");
    write_all(fd, initial, sizeof(initial) - 1);
    if (fsync(fd) == -1)
        fail("sync initial held file failed");
    int append_flags = fcntl(fd, F_GETFL);
    if (append_flags == -1)
        fail("held F_GETFL failed");
    require(append_flags & O_APPEND, "held descriptor lacks O_APPEND");
    if (fstat(fd, &before) == -1)
        fail("held fstat before host replacement failed");

    await_host_replacement();

    set_append_flag(fd, append_flags, 0);
    require(lseek(fd, 1, SEEK_SET) == 1, "seek on held descriptor failed");
    write_all(fd, "B", 1);
    require(lseek(fd, 0, SEEK_CUR) == 2, "cleared held descriptor did not honor its offset");
    check_descriptor(fd, after_clear, sizeof(after_clear) - 1);

    set_append_flag(fd, append_flags, 1);
    require(lseek(fd, 0, SEEK_SET) == 0, "seek before held append failed");
    write_all(fd, "C", 1);
    require(lseek(fd, 0, SEEK_CUR) == 9, "restored held descriptor did not append");
    check_descriptor(fd, after_append, sizeof(after_append) - 1);
    if (fstat(fd, &after) == -1)
        fail("held fstat after host replacement failed");
    require(after.st_dev == before.st_dev && after.st_ino == before.st_ino,
            "held descriptor changed inode after host replacement");
    if (fsync(fd) == -1)
        fail("sync held descriptor failed");
    if (close(fd) == -1)
        fail("close held descriptor failed");
}

static void stage_unlinked_descriptor(const char *path)
{
    static const char initial[] = "old-data";
    static const char after_clear[] = "Qld-data";
    static const char after_append[] = "Qld-dataR";
    static const char replacement[] = "new-data";
    struct stat info;

    int fd = open(path, O_CREAT | O_TRUNC | O_RDWR | O_APPEND, 0600);
    if (fd == -1)
        fail("create unlinked file failed");
    write_all(fd, initial, sizeof(initial) - 1);
    if (fsync(fd) == -1)
        fail("sync initial unlinked file failed");
    int append_flags = fcntl(fd, F_GETFL);
    if (append_flags == -1)
        fail("unlinked F_GETFL failed");
    require(append_flags & O_APPEND, "unlinked descriptor lacks O_APPEND");

    if (unlink(path) == -1)
        fail("unlink original pathname failed");
    int replacement_fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (replacement_fd == -1)
        fail("create replacement pathname failed");
    write_all(replacement_fd, replacement, sizeof(replacement) - 1);
    if (fsync(replacement_fd) == -1)
        fail("sync replacement pathname failed");
    if (close(replacement_fd) == -1)
        fail("close replacement pathname failed");

    set_append_flag(fd, append_flags, 0);
    require(lseek(fd, 0, SEEK_SET) == 0, "seek on unlinked descriptor failed");
    write_all(fd, "Q", 1);
    require(lseek(fd, 0, SEEK_CUR) == 1, "cleared unlinked descriptor did not honor its offset");
    check_descriptor(fd, after_clear, sizeof(after_clear) - 1);

    set_append_flag(fd, append_flags, 1);
    require(lseek(fd, 0, SEEK_SET) == 0, "seek before unlinked append failed");
    write_all(fd, "R", 1);
    require(lseek(fd, 0, SEEK_CUR) == 9, "restored unlinked descriptor did not append");
    check_descriptor(fd, after_append, sizeof(after_append) - 1);
    if (fstat(fd, &info) == -1)
        fail("fstat on unlinked descriptor failed");
    require(info.st_nlink == 0, "unlinked descriptor still has a directory link");
    if (fsync(fd) == -1)
        fail("sync unlinked descriptor failed");
    check_path(path, replacement, sizeof(replacement) - 1);
    if (close(fd) == -1)
        fail("close unlinked descriptor failed");
}

int main(int argc, char **argv)
{
    char toggle_path[path_capacity];
    char held_path[path_capacity];
    char unlinked_path[path_capacity];

    setvbuf(stdout, NULL, _IONBF, 0);
    require(argc == 2, "expected one existing test directory argument");
    make_path(toggle_path, argv[1], "toggle");
    make_path(held_path, argv[1], "held");
    make_path(unlinked_path, argv[1], "unlinked");

    stage_toggle(toggle_path);
    stage_held_descriptor(held_path);
    puts("append flags: clearing, restoring and clearing O_APPEND honors offsets pass");
    puts("append flags: held descriptor writes retain the replaced inode pass");
    stage_unlinked_descriptor(unlinked_path);
    puts("append flags: unlinked descriptor remains independent of recreated path pass");
    return 0;
}
