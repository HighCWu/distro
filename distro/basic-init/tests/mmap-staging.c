/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <stdint.h>
#include <sys/mman.h>
#include <unistd.h>

/* Private fixture slot, available only with CONFIG_WASM_MMAP_COPY_TEST.
 * Not a Linux UAPI number for applications or a supported SDK interface. */
#define STAGING_TEST_NR 253

extern long __wasm_mmap_init_v1(size_t, size_t);

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	size_t lengths[] = { 0, 1, page + 7, 2 * page };
	if (page != 65536) test_fail("unexpected staging mmap page size");
	errno = 0;
	if (syscall(STAGING_TEST_NR, (unsigned long)(2 * page + 1)) != -1 || errno != EINVAL)
		test_fail("oversized staging fixture accepted");
	for (int round = 0; round < 8; round++) {
		for (size_t j = 0; j < sizeof(lengths) / sizeof(lengths[0]); j++) {
			long result = syscall(STAGING_TEST_NR, (unsigned long)lengths[j]);
			if (result == -1) test_perror("kernel staging copy");
			unsigned char *bytes = (void *)(uintptr_t)result;
			if ((uintptr_t)bytes % page) test_fail("unaligned staging mapping");
			for (size_t i = 0; i < 2 * page; i++) {
				unsigned char expected = i < lengths[j] ? (unsigned char)(i * 37 + 11) : 0;
				if (bytes[i] != expected) test_fail("staging content or zero tail damaged");
			}
			/* The source has already been freed by the kernel. Published
			 * user backing must remain independent and support normal unmap. */
			bytes[0] = 0xa5;
			if (munmap(bytes + page, page) || munmap(bytes, page))
				test_perror("staging mapping cleanup");
			if (__wasm_mmap_init_v1(page, 0) != -EPERM)
				test_fail("staging copy authorization survived syscall return");
		}
	}
	test_pass();
}
