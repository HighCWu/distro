/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <stdint.h>
#include <sys/mman.h>
#include <unistd.h>
#include "mmap-vfs-stats.h"

/* Private fixture slots in the opt-in test kernel, never application UAPI.
 * Offset is split explicitly so the test contract retains 64 bits on wasm32. */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255

static long read_mapping(int fd, size_t length, uint64_t offset)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)length,
		(unsigned long)(uint32_t)offset, (unsigned long)(uint32_t)(offset >> 32));
}

static void rejected(int fd, size_t length, uint64_t offset, int expected)
{
	errno = 0;
	if (read_mapping(fd, length, offset) != -1 || errno != expected)
		test_fail("VFS mapping fixture refusal mismatch");
}

int main(void)
{
	mmap_stats_start();
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected VFS mapping page size");
	int ordinary = open("/init", O_RDONLY);
	if (ordinary < 0) test_perror("open ordinary readonly file");
	rejected(ordinary, page, 0, EOPNOTSUPP);
	if (close(ordinary)) test_perror("close ordinary file");
	rejected(-1, page, 0, EBADF);
	for (int mode = 0; mode <= 3; mode++) {
		mmap_stats_wait(0, 0, 0);
		int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
		if (fd < 0) test_perror("create immutable fixture");
		if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set fixture position");
		if (mode) {
			for (int i = 0; i < 16; i++) {
				rejected(fd, page, 0, mode == 3 ? EINTR : EIO);
				mmap_stats_expect(0, 0, 1);
			}
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("failed read changed file position");
			if (close(fd)) test_perror("close failed fixture");
			int recovery = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)0);
			if (recovery < 0) test_perror("create recovery fixture");
			long recovered = read_mapping(recovery, page, 0);
			if (recovered == -1) test_perror("read after injected failure");
			unsigned char *restored = (void *)(uintptr_t)recovered;
			if (restored[0] != 11 || restored[page - 1] != (unsigned char)((page - 1) * 37 + 11))
				test_fail("recovery mapping content damaged");
			if (munmap(restored, page) || close(recovery)) test_perror("recovery cleanup");
			continue;
		}
		rejected(fd, 0, 0, EINVAL);
		rejected(fd, 2 * page + 1, 0, EINVAL);
		rejected(fd, page, 1, EINVAL);
		rejected(fd, page, UINT64_C(1) << 32, EINVAL);
		rejected(fd, page, UINT64_C(1) << 63, EINVAL);
		rejected(fd, 2 * page, 2 * page, EINVAL);
		rejected(fd, page, 3 * page, EINVAL);
		long full = read_mapping(fd, 2 * page, page);
		long tail = read_mapping(fd, 1, 2 * page);
		if (full == -1 || tail == -1) test_perror("read immutable fixture");
		if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("mapping read changed file position");
		if (close(fd)) test_perror("close mapped fixture");
		int replacement = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)0);
		if (replacement != fd) test_fail("fixture fd was not reused");
		unsigned char *bytes = (void *)(uintptr_t)full;
		unsigned char *last = (void *)(uintptr_t)tail;
		for (size_t i = 0; i < 2 * page; i++) {
			unsigned char expected = i < page + 7 ? (unsigned char)((page + i) * 37 + 11) : 0;
			if (bytes[i] != expected) test_fail("VFS copied content or tail mismatch");
		}
		for (size_t i = 0; i < page; i++) {
			unsigned char expected = i < 7 ? (unsigned char)((2 * page + i) * 37 + 11) : 0;
			if (last[i] != expected) test_fail("last partial page mismatch");
		}
		bytes[0] = 0xa5;
		if (last[0] != 11) test_fail("independent mapping was modified");
		if (munmap(bytes, 2 * page) || munmap(last, page)) test_perror("VFS mapping cleanup");
		if (close(replacement)) test_perror("close replacement fixture");
	}
	mmap_stats_wait(0, 0, 0);
	test_pass();
}
