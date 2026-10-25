/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
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
	rejected(ordinary, page, PROT_READ, MAP_PRIVATE, 0, EOPNOTSUPP);
	rejected(init, page, PROT_READ, MAP_PRIVATE, 0, EOPNOTSUPP);
	rejected(directory, page, PROT_READ, MAP_PRIVATE, 0, EOPNOTSUPP);
	/* fget() excludes O_PATH descriptors before the FMODE_READ check. */
	rejected(path, page, PROT_READ, MAP_PRIVATE, 0, EBADF);
	rejected(empty, page, PROT_READ, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, 0, PROT_READ, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, 2 * page + 1, PROT_READ, MAP_PRIVATE, 0, ENOMEM);
	rejected(fd, page, PROT_NONE, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, page, PROT_READ | PROT_EXEC, MAP_PRIVATE, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_SHARED, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_LOCKED, 0, EINVAL);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_FIXED, 0, ENOMEM);
	rejected(fd, page, PROT_READ, MAP_PRIVATE | MAP_FIXED_NOREPLACE, 0, ENOMEM);
	rejected(fd, page, PROT_READ, MAP_PRIVATE, 4096, EINVAL);
	rejected(fd, 2 * page, PROT_READ, MAP_PRIVATE, 2 * page, EINVAL);
	rejected(fd, page, PROT_READ, MAP_PRIVATE, (off_t)UINT64_C(0x100000000), EINVAL);
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
