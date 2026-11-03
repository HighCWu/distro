// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "This workload checks direct NOMMU zero-tail semantics inside Linux on Wasm"
#endif
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: file mmap stream: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static unsigned char value(size_t offset)
{
    return (unsigned char)(offset * 29 + (offset >> 16) * 13 + 7);
}

static void content(const unsigned char *bytes, size_t length, size_t offset, size_t file_size)
{
    for (size_t i = 0; i < length; i++)
        require(bytes[i] == (offset + i < file_size ? value(offset + i) : 0),
                "complete private contents and zero tail");
}

static void rejected(int fd, size_t length, int prot, int flags, off_t offset, int error)
{
    errno = 0;
    require(mmap(NULL, length, prot, flags, fd, offset) == MAP_FAILED && errno == error,
            "standard mapping rejection");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    const size_t page = 65536, size = 4 * 1024 * 1024 + 7, rounded = 65 * page;
    require(sysconf(_SC_PAGESIZE) == (long)page, "Wasm page size");
    int fd = open("/stream-file", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
    require(fd >= 0, "create ordinary source");
    unsigned char *buffer = malloc(page);
    require(buffer != NULL, "bounded source-write buffer");
    for (size_t offset = 0; offset < size;) {
        size_t count = size - offset < page ? size - offset : page;
        for (size_t i = 0; i < count; i++) buffer[i] = value(offset + i);
        ssize_t written = write(fd, buffer, count);
        require(written > 0, "source write progress");
        offset += written;
    }
    free(buffer);
    require(lseek(fd, 23, SEEK_SET) == 23, "shared descriptor position");
    unsigned char *first = mmap(NULL, size, PROT_READ, MAP_PRIVATE | MAP_POPULATE, fd, 0);
    require(first != MAP_FAILED, "map larger than old full-staging budget");
    content(first, rounded, 0, size);
    unsigned char *second = mmap(NULL, 32 * page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, page);
    require(second != MAP_FAILED, "large nonzero-offset private map");
    content(second, 32 * page, page, size);
    second[0] ^= 0x55;
    unsigned char original = 0;
    require(first[page] == value(page) && pread(fd, &original, 1, page) == 1 && original == value(page) &&
            lseek(fd, 0, SEEK_CUR) == 23, "independent copies and unchanged file offset");
    puts("file mmap stream: multi-megabyte reads, nonzero offset, private copies and fd position pass");

    require(ftruncate(fd, page + 17) == 0, "truncate mutable source");
    unsigned char *tail = mmap(NULL, 48 * page, PROT_READ, MAP_PRIVATE, fd, 0);
    require(tail != MAP_FAILED, "large short-read copy");
    content(tail, 48 * page, 0, page + 17);
    unsigned char *empty = mmap(NULL, 3 * page, PROT_READ, MAP_PRIVATE, fd, 2 * page);
    require(empty != MAP_FAILED, "copy wholly beyond EOF");
    content(empty, 3 * page, 2 * page, page + 17);
    content(first, rounded, 0, size);
    puts("file mmap stream: short reads, EOF zero tails, truncation and source lifetime pass");

    rejected(-1, 3 * page, PROT_READ, MAP_PRIVATE, 0, EBADF);
    rejected(fd, 3 * page, PROT_EXEC, MAP_PRIVATE, 0, EINVAL);
    rejected(fd, 3 * page, PROT_READ, MAP_SHARED, 0, EINVAL);
    rejected(fd, 3 * page, PROT_READ, MAP_PRIVATE, 1, EINVAL);
    require(madvise(first, rounded, MADV_DONTNEED) == -1 && errno == EOPNOTSUPP &&
            msync(first, rounded, MS_SYNC) == 0, "copied file provenance preserved");
    errno = 0;
    require(madvise(first, rounded, MADV_FREE) == -1 && errno == EINVAL,
            "FREE refuses private file copies");
    require(close(fd) == 0 && unlink("/stream-file") == 0, "close and unlink source");
    content(first, rounded, 0, size);
    require(munmap(first, page) == 0 && munmap(first + page, rounded - page) == 0 &&
            munmap(second, 32 * page) == 0 && munmap(tail, 48 * page) == 0 &&
            munmap(empty, 3 * page) == 0, "split and complete mapping cleanup");
    unsigned char *later = mmap(NULL, rounded, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    require(later != MAP_FAILED, "anonymous allocation after stream cleanup");
    for (size_t i = 0; i < rounded; i++) require(!later[i], "reused backing is zeroed");
    require(munmap(later, rounded) == 0, "later allocation cleanup");
    puts("file mmap stream: rejection rollback, split unmap and later allocation recovery pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
