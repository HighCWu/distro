/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__wasm__)
#if __SIZEOF_LONG__ == 4
#if !defined(SYS__llseek) || !defined(SYS_mmap2) || defined(SYS_lseek)
#error "wasm32 must use llseek and mmap2 syscall layouts"
#endif
#else
#if !defined(SYS_lseek) || defined(SYS__llseek) || defined(SYS_mmap2)
#error "wasm64 must use lseek and byte-offset mmap syscall layouts"
#endif
#endif
#endif

/* This is a rejection preflight, not proof of successful file mapping or
 * offset normalization. Keep libc byte offsets distinct from raw ABI units. */
static void rejected(long result, const char *operation)
{
	if (result != -1 || errno != EINVAL)
		test_fail(operation);
}

static long raw_mmap(size_t length, int flags, int fd, uintptr_t offset)
{
	return syscall(SYS_mmap, 0L, (long)length,
		       (long)(PROT_READ | PROT_WRITE), (long)flags,
		       (long)fd, (long)offset);
}

static off_t raw_lseek(int fd, off_t offset, int whence)
{
#ifdef SYS__llseek
	off_t result = -1;
	long status = syscall(SYS__llseek, (long)fd,
		(long)((uint64_t)offset >> 32), (long)(uint32_t)offset,
		(long)(uintptr_t)&result, (long)whence, 0L);
	return status == -1 ? -1 : result;
#else
	return syscall(SYS_lseek, (long)fd, (long)offset, (long)whence,
		       0L, 0L, 0L);
#endif
}

int main(void)
{
	const off_t byte_offsets[] = {
		0, 1, 4096, 65536, (off_t)1 << 32, (off_t)1 << 44, -1,
	};
	size_t page_size = (size_t)sysconf(_SC_PAGESIZE);
	uintptr_t syscall_unit = sizeof(uintptr_t) == 4 ? 4096 : 1;
	uintptr_t raw_offsets[] = {
		0, 1, page_size / syscall_unit, UINTPTR_MAX,
		(uintptr_t)((UINT64_C(1) << 32) / syscall_unit),
	};
	unsigned char *sentinel;
	int fd;

	_Static_assert(sizeof(off_t) == 8, "file offsets must be 64-bit");
	if (page_size != 65536)
		test_fail("unexpected mmap offset preflight page size");
	/* /init exists in both raw initramfs profiles; use a real regular-file fd
	 * so a bad descriptor cannot mask accidental file-mapping acceptance. */
	fd = open("/init", O_RDONLY);
	if (fd < 0)
		test_perror("open offset fixture");
	/* Seek beyond 4 GiB without allocating a large file. This checks file
	 * offset transport, not large-file I/O or large linear-memory capacity. */
	if (lseek(fd, ((off_t)1 << 33) + 7, SEEK_SET) != ((off_t)1 << 33) + 7 ||
	    raw_lseek(fd, 0, SEEK_CUR) != ((off_t)1 << 33) + 7)
		test_fail("libc large seek disagrees with raw file position");
	if (raw_lseek(fd, ((off_t)1 << 32) + 3, SEEK_SET) != ((off_t)1 << 32) + 3 ||
	    lseek(fd, 0, SEEK_CUR) != ((off_t)1 << 32) + 3)
		test_fail("raw large seek disagrees with libc file position");
	if (lseek(fd, 7, SEEK_SET) != 7)
		test_perror("seek offset fixture");
	sentinel = mmap(0, page_size, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED)
		test_perror("offset sentinel mmap");
	sentinel[0] = 0x3c;
	sentinel[page_size - 1] = 0xc3;

	for (size_t i = 0; i < sizeof(byte_offsets) / sizeof(byte_offsets[0]); i++) {
		errno = 0;
		rejected((long)(intptr_t)mmap(0, page_size, PROT_READ | PROT_WRITE,
					      MAP_PRIVATE, fd, byte_offsets[i]),
			 "libc file offset request was not rejected");
		if (!byte_offsets[i])
			continue;
		errno = 0;
		rejected((long)(intptr_t)mmap(0, page_size, PROT_READ | PROT_WRITE,
					      MAP_PRIVATE | MAP_ANONYMOUS, -1,
					      byte_offsets[i]),
			 "libc anonymous nonzero offset was not rejected");
	}
	for (size_t i = 0; i < sizeof(raw_offsets) / sizeof(raw_offsets[0]); i++) {
		errno = 0;
		rejected(raw_mmap(page_size, MAP_PRIVATE, fd, raw_offsets[i]),
			 "raw file offset request was not rejected");
		if (!raw_offsets[i])
			continue;
		errno = 0;
		rejected(raw_mmap(page_size, MAP_PRIVATE | MAP_ANONYMOUS, -1,
				  raw_offsets[i]),
			 "raw anonymous nonzero offset was not rejected");
	}
	if (lseek(fd, 0, SEEK_CUR) != 7)
		test_fail("rejected mmap changed file position");
	if (sentinel[0] != 0x3c || sentinel[page_size - 1] != 0xc3)
		test_fail("rejected mmap damaged live anonymous mapping");
	if (close(fd) || munmap(sentinel, page_size))
		test_perror("offset preflight cleanup");
	printf("mmap-offset-preflight: pointer_bits=%zu page=%zu raw_unit=%zu\n",
	       sizeof(uintptr_t) * 8, page_size, (size_t)syscall_unit);
	test_pass();
}
