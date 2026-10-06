/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <stdint.h>
#include <sys/mman.h>
#include <unistd.h>

extern long __wasm_mmap_init_v1(size_t, size_t);

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	unsigned char *live;
	if (page != 65536) test_fail("unexpected copy mmap page size");
	if (__wasm_mmap_init_v1(0, 0) != -EINVAL ||
	    __wasm_mmap_init_v1(page - 1, 0) != -EINVAL ||
	    __wasm_mmap_init_v1(page, page + 1) != -EINVAL)
		test_fail("invalid copy extent accepted");
	live = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (live == MAP_FAILED) test_perror("live mapping");
	live[0] = 0x5a;
	live[page - 1] = 0xa5;
	/* No kernel staging lease exists for a direct user call. A real host import
	 * must deny it, and the actual musl allocator must roll back its candidate.
	 * This is not a successful file mapping or a proof of all allocator leaks. */
	for (int i = 0; i < 32; i++) {
		if (__wasm_mmap_init_v1(2 * page, page + 7) != -EPERM ||
		    __wasm_mmap_init_v1(page, 0) != -EPERM)
			test_fail("copy without kernel lease accepted");
		unsigned char *next = mmap(0, page, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (next == MAP_FAILED) test_perror("allocation after copy rollback");
		if (next[0] || next[page - 1] || live[0] != 0x5a || live[page - 1] != 0xa5)
			test_fail("copy rollback damaged anonymous mapping");
		if (munmap(next, page)) test_perror("copy rollback cleanup");
	}
	if (munmap(live, page)) test_perror("live mapping cleanup");
	test_pass();
}
