// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok)
		return;
	printf("::vm-test::fail: mincore-nommu: %s errno=%d\n", what, errno);
	fflush(stdout);
	_Exit(1);
}

int main(void)
{
	long page_result = sysconf(_SC_PAGESIZE);
	require(page_result > 0, "query page size");
	size_t page_size = (size_t)page_result;
	require(page_size <= SIZE_MAX / 3, "three-page length does not overflow");
	size_t length = page_size * 3;
	unsigned char *mapping = mmap(NULL, length, PROT_READ | PROT_WRITE,
				      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(mapping != MAP_FAILED, "allocate three-page anonymous VMA");
	/* Keep the native reference's lazy anonymous pages resident as well. */
	mapping[0] = 1;
	mapping[page_size] = 2;
	mapping[2 * page_size] = 3;

	unsigned char residency[3] = { 0xa5, 0xa5, 0xa5 };
	require(mincore(mapping, length, residency) == 0,
		"query one resident NOMMU VMA");
	require((residency[0] & 1) && (residency[1] & 1) &&
		(residency[2] & 1), "all covered pages report resident");

	/* An anonymous VMA can be split, leaving a real hole between two VMAs. */
	require(munmap(mapping + page_size, page_size) == 0,
		"remove middle page and create a mapping hole");
	residency[0] = 0xa5;
	residency[1] = 0x5a;
	residency[2] = 0xc3;
	errno = 0;
	require(mincore(mapping, length, residency) == -1 && errno == ENOMEM,
		"reject a range containing an unmapped hole");
	require((residency[0] & 1) && residency[1] == 0x5a &&
		residency[2] == 0xc3,
		"preserve the copied prefix and untouched suffix on a hole");

	require(munmap(mapping, page_size) == 0 &&
		munmap(mapping + 2 * page_size, page_size) == 0,
		"release the remaining mappings");
	require(mincore(mapping, 0, residency) == 0,
		"zero-length query does not require a mapped range");

	puts("mincore-nommu: resident VMA, hole error and partial prefix pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;)
		sched_yield();
#else
	return 0;
#endif
}
