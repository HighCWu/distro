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

#define DATA_PAGE 65536u

__attribute__((aligned(DATA_PAGE), used))
static volatile unsigned char initialized_data[DATA_PAGE] = { 0x5a };
__attribute__((aligned(DATA_PAGE), used))
static volatile unsigned char zero_initialized_bss[2 * DATA_PAGE];

static void require(int ok, const char *what)
{
	if (ok)
		return;
	printf("::vm-test::fail: mincore-nommu: %s errno=%d\n", what, errno);
	fflush(stdout);
	_Exit(1);
}

static void require_resident(void *address, size_t length, size_t page_size,
			     const char *what)
{
	unsigned char residency[64];
	size_t pages = length / page_size;
	size_t index;

	require(length % page_size == 0, "residency length is page aligned");
	require(pages > 0 && pages <= sizeof(residency),
		"residency vector fits local buffer");
	memset(residency, 0, sizeof(residency));
	require(mincore(address, length, residency) == 0, what);
	for (index = 0; index < pages; ++index)
		require(residency[index] & 1, "covered page reports resident");
}

int main(void)
{
	long page_result = sysconf(_SC_PAGESIZE);
	require(page_result > 0, "query page size");
	size_t page_size = (size_t)page_result;
#ifdef __wasm__
	require(page_size == DATA_PAGE, "Wasm page size is 64 KiB");
#else
	require(page_size <= DATA_PAGE && DATA_PAGE % page_size == 0,
		"native page size divides data test range");
#endif

	for (size_t offset = 0; offset < DATA_PAGE; offset += page_size) {
		if (offset == 0)
			require(initialized_data[offset] == 0x5a,
				"read initialized static data");
		(void)initialized_data[offset];
	}
	for (size_t offset = 0; offset < 2 * DATA_PAGE; offset += page_size)
		zero_initialized_bss[offset] = 0;
	require(zero_initialized_bss[0] == 0, "read zero-initialized BSS");
	require_resident((void *)initialized_data, DATA_PAGE, page_size,
			 "query initialized static data");
	require_resident((void *)zero_initialized_bss, 2 * DATA_PAGE, page_size,
			 "query zero-initialized BSS");
	require_resident((void *)(zero_initialized_bss + DATA_PAGE), DATA_PAGE,
			 page_size, "query final BSS test page");
	puts("mincore-nommu: initial image data and BSS residency pass");
	fflush(stdout);

	require(page_size <= SIZE_MAX / 3, "three-page length does not overflow");
	size_t length = page_size * 3;
	unsigned char *mapping = mmap(NULL, length, PROT_READ | PROT_WRITE,
				      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(mapping != MAP_FAILED, "allocate three-page anonymous VMA");
	require(!((uintptr_t)mapping & (page_size - 1)),
		"anonymous VMA is page aligned");
	/* Keep the native reference's lazy anonymous pages resident as well. */
	for (size_t offset = 0; offset < length; offset += page_size)
		mapping[offset] = (unsigned char)(offset / page_size + 1);

	unsigned char residency[3] = { 0xa4, 0xa4, 0xa4 };
	require(mincore(mapping, length, residency) == 0,
		"query one resident NOMMU VMA");
	require((residency[0] & 1) && (residency[1] & 1) &&
		(residency[2] & 1), "all covered pages report resident");

	/* An anonymous VMA can be split, leaving a real hole between two VMAs. */
	require(munmap(mapping + page_size, page_size) == 0,
		"remove middle page and create a mapping hole");
	residency[0] = 0xa4;
	residency[1] = 0x5a;
	residency[2] = 0xc3;
	errno = 0;
	require(mincore(mapping, length, residency) == -1 && errno == ENOMEM,
		"unmapped hole returns ENOMEM");
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
