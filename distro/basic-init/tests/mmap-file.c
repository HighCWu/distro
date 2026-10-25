/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#define _LARGEFILE64_SOURCE
#include "test.h"
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

/* 0: default kernel; 1: candidate plus execution export; 2: old user module.
 * All application requests use standard Linux mmap/munmap, no fixture UAPI. */
#ifndef FILE_MMAP_MODE
#define FILE_MMAP_MODE 1
#endif

static void rejected(int fd, size_t length, int prot, int flags,
		     off_t offset, int expected)
{
	errno = 0;
	void *result = mmap(NULL, length, prot, flags, fd, offset);
	int actual = errno;
	if (result != MAP_FAILED || actual != expected) {
		printf("file mmap refusal: fd=%d length=%zu prot=%#x flags=%#x "
		       "offset=%llu result=%p errno=%d expected=%d\n",
		       fd, length, prot, flags, (unsigned long long)offset,
		       result, actual, expected);
		test_fail("standard file mmap refusal mismatch");
	}
}

#if FILE_MMAP_MODE == 1
static void content(const unsigned char *bytes, size_t length, size_t offset,
		    size_t source_size)
{
	for (size_t i = 0; i < length; i++) {
		unsigned char expected = offset + i < source_size ?
			(unsigned char)((offset + i) * 37 + 11) : 0;
		if (bytes[i] != expected) test_fail("standard file copy content/tail mismatch");
	}
}

static void zero_mapping(int fd, size_t length, off64_t offset)
{
	unsigned char *bytes = mmap64(NULL, length, PROT_READ, MAP_PRIVATE, fd, offset);
	if (bytes == MAP_FAILED) test_perror("NOMMU EOF mapping");
	for (size_t i = 0; i < length; i++)
		if (bytes[i]) test_fail("NOMMU EOF tail is not zero");
	if (munmap(bytes, length)) test_perror("NOMMU EOF unmap");
}

static void mutable_mapping(size_t page)
{
	int fd = open("/mutable", O_CREAT | O_EXCL | O_RDWR, 0600);
	if (fd < 0) test_perror("create mutable mapping source");
	int write_only = open("/mutable", O_WRONLY);
	if (write_only < 0) test_perror("open write-only mapping source");
	rejected(write_only, page, PROT_READ, MAP_PRIVATE, 0, EACCES);
	if (close(write_only)) test_perror("close write-only source");
	unsigned char *buffer = malloc(page);
	if (!buffer) test_perror("mutable source buffer");
	for (size_t i = 0; i < page; i++) buffer[i] = (unsigned char)(i * 37 + 11);
	for (size_t offset = 0; offset < 2 * page + 7;) {
		size_t size = 2 * page + 7 - offset;
		if (size > page) size = page;
		ssize_t written = write(fd, buffer, size);
		if (written <= 0) test_perror("write mutable source");
		/* Fill from the absolute file offset even after a short write. */
		offset += (size_t)written;
		for (size_t i = 0; i < page; i++) buffer[i] = (unsigned char)((offset + i) * 37 + 11);
	}
	free(buffer);
	if (lseek(fd, 23, SEEK_SET) != 23) test_perror("mutable source position");
	unsigned char *before = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
	if (before == MAP_FAILED) test_perror("mutable source mapping");
	content(before, 2 * page, 0, 2 * page + 7);
	unsigned char changed = 0xa5;
	if (pwrite(fd, &changed, 1, 0) != 1) test_perror("change mapped source");
	content(before, 2 * page, 0, 2 * page + 7);
	unsigned char *after = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
	if (after == MAP_FAILED || after[0] != changed) test_fail("fresh NOMMU copy missed file write");
	after[0] = 0x5a;
	unsigned char disk;
	if (pread(fd, &disk, 1, 0) != 1 || disk != changed)
		test_fail("private copy wrote back to source");
	if (ftruncate(fd, 7)) test_perror("truncate mapped source");
	unsigned char *shorter = mmap(NULL, 2 * page, PROT_READ, MAP_PRIVATE, fd, 0);
	if (shorter == MAP_FAILED || shorter[0] != changed) test_fail("truncated NOMMU prefix missing");
	content(shorter + 1, 2 * page - 1, 1, 7);
	zero_mapping(fd, page, page);
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("mutable mapping changed fd position");
	if (unlink("/mutable") || close(fd)) test_perror("unlink mapped source");
	content(before, 2 * page, 0, 2 * page + 7);
	if (shorter[0] != changed || after[0] != 0x5a) test_fail("private copies lost identity");
	if (munmap(before, 2 * page) || munmap(after, page) || munmap(shorter, 2 * page))
		test_perror("mutable mapping cleanup");
	puts("file mmap: mutable file writes, truncate, EOF, unlink and private lifetime verified");
}
#endif

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected file mmap page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) || mkdir("/ordinary", 0755)) test_perror("mkdir mounts");
	if (mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL) ||
	    mount("/dev/vdb", "/ordinary", "erofs", MS_RDONLY, NULL)) test_perror("mount EROFS");
	int fd = open("/snapshot/pattern", O_RDONLY);
	int ordinary = open("/ordinary/pattern", O_RDONLY);
	if (fd < 0 || ordinary < 0) test_perror("open file mmap sources");
	unsigned char *sentinel = mmap(NULL, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("anonymous sentinel");
	memset(sentinel, 0x5a, page);

#if FILE_MMAP_MODE != 1
	for (int round = 0; round < 8; round++) {
		int error = FILE_MMAP_MODE == 0 ? EINVAL : EOPNOTSUPP;
		rejected(fd, page, PROT_READ, MAP_PRIVATE, 0, error);
		rejected(fd, page, PROT_READ | PROT_WRITE, MAP_PRIVATE, 0, error);
	}
	puts(FILE_MMAP_MODE == 0 ? "file mmap: default kernel remains closed" :
		"file mmap: old module refused without initialized-copy export");
#else
	int empty = open("/snapshot/empty", O_RDONLY);
	int directory = open("/snapshot", O_RDONLY | O_DIRECTORY);
	int path = open("/snapshot/pattern", O_PATH);
	int init = open("/init", O_RDONLY);
	if (empty < 0 || directory < 0 || path < 0 || init < 0) test_perror("open refusal sources");
	rejected(-1, page, PROT_READ, MAP_PRIVATE, 0, EBADF);
	rejected(directory, page, PROT_READ, MAP_PRIVATE, 0, EOPNOTSUPP);
	/* fget() excludes O_PATH descriptors before the FMODE_READ check. */
	rejected(path, page, PROT_READ, MAP_PRIVATE, 0, EBADF);
	zero_mapping(empty, page, 0);
	rejected(fd, 0, PROT_READ, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, 2 * page + 1, PROT_READ, MAP_PRIVATE, 0, ENOMEM);
	rejected(fd, page, PROT_NONE, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, page, PROT_READ | PROT_EXEC, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_SHARED, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_LOCKED, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_FIXED, 0, ENOMEM);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_FIXED_NOREPLACE, 0, ENOMEM);
	rejected(fd, page, PROT_READ, MAP_PRIVATE, 4096, EINVAL);
	zero_mapping(fd, page, (off_t)UINT64_C(0x100000000));
	unsigned char *ordinary_copy = mmap(NULL, page, PROT_READ, MAP_PRIVATE, ordinary, page);
	if (ordinary_copy == MAP_FAILED) test_perror("ordinary disk file mapping");
	content(ordinary_copy, page, page, 2 * page + 7);
	if (munmap(ordinary_copy, page)) test_perror("ordinary mapping cleanup");
	mutable_mapping(page);
	if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set standard mmap fd position");
	const int hints[] = { MAP_POPULATE, MAP_NONBLOCK, MAP_NORESERVE,
		MAP_STACK, MAP_DENYWRITE, MAP_EXECUTABLE,
		MAP_POPULATE | MAP_NONBLOCK | MAP_NORESERVE | MAP_STACK |
		MAP_DENYWRITE | MAP_EXECUTABLE };
	for (size_t i = 0; i < sizeof(hints) / sizeof(hints[0]); i++) {
		unsigned char *hinted = mmap(NULL, page, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | hints[i], fd, page);
		if (hinted == MAP_FAILED) test_perror("standard file mmap hints");
		content(hinted, page, page, 2 * page + 7);
		hinted[0] ^= 0xff;
		unsigned char original;
		if (pread(fd, &original, 1, page) != 1 || original != 11 ||
		    lseek(fd, 0, SEEK_CUR) != 23)
			test_fail("hinted mapping changed source or descriptor position");
		if (munmap(hinted, page)) test_perror("hinted mapping cleanup");
	}
	puts("file mmap: advisory flags preserve private content, position and cleanup");
	unsigned char *ro = mmap(NULL, 2 * page, PROT_READ, MAP_PRIVATE, fd, page);
	unsigned char *rw = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, page);
	unsigned char *tail = mmap(NULL, 1, PROT_READ, MAP_PRIVATE, fd, 2 * page);
	if (ro == MAP_FAILED || rw == MAP_FAILED || tail == MAP_FAILED)
		test_perror("standard immutable file mapping");
	content(ro, 2 * page, page, 2 * page + 7);
	content(rw, 2 * page, page, 2 * page + 7);
	content(tail, page, 2 * page, 2 * page + 7);
	/* Exercise the raw syscall too: mmap2 counts 4096-byte units on wasm32,
	 * while mmap takes bytes on wasm64. Neither offset crosses the host ABI. */
	unsigned long raw_offset = sizeof(long) == 4 ? page / 4096 : page;
	long result = syscall(222, 0UL, (unsigned long)page, (unsigned long)PROT_READ,
		(unsigned long)MAP_PRIVATE, (unsigned long)fd, raw_offset);
	if (result == -1) test_perror("raw file mmap offset normalization");
	unsigned char *raw = (void *)(uintptr_t)result;
	content(raw, page, page, 2 * page + 7);
	rw[0] ^= 0xff;
	content(ro, 2 * page, page, 2 * page + 7);
	unsigned char original;
	if (pread(fd, &original, 1, page) != 1 || original != 11)
		test_fail("private mapping modified source");
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("file mmap changed shared fd position");
	if (close(empty) || close(directory) || close(path) || close(init))
		test_perror("close refusal sources");
	if (close(fd)) test_perror("close mapped source");
	fd = -1;
	content(ro, 2 * page, page, 2 * page + 7);
	if (munmap(ro, 2 * page) || munmap(rw, 2 * page) || munmap(tail, page) || munmap(raw, page))
		test_perror("standard file mapping cleanup");
	puts("file mmap: immutable RO/RW copies, offset, EOF tail and independence verified");
#endif
	for (size_t i = 0; i < page; i++)
		if (sentinel[i] != 0x5a) test_fail("file mmap damaged anonymous sentinel");
	if ((fd >= 0 && close(fd)) || close(ordinary) || munmap(sentinel, page))
		test_perror("file mmap final cleanup");
	test_pass();
}
