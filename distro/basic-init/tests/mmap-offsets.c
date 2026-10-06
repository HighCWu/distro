/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

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
