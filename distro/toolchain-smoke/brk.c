/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error This workload validates the existing Wasm monotonic break allocator, not native libc brk
#endif
#include <errno.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: brk: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
#define require(ok, what) do { if (!(ok)) fail(what); } while (0)
int main(void)
{
	void *before = sbrk(0);
	require(before != (void *)-1, "initial break query");
	errno = 0;
	require(sbrk(INTPTR_MIN) == (void *)-1 && errno == ENOMEM && sbrk(0) == before,
	        "extreme negative increment rejected without changing break");
	errno = 0;
	require(sbrk(-1) == (void *)-1 && errno == ENOMEM && sbrk(0) == before,
	        "monotonic allocator retains existing shrink refusal");
	puts("brk: existing queries, negative admission and unchanged break pass");

	before = sbrk(0);
	unsigned char *owned = sbrk(65536);
	require(owned == before && (uintptr_t)sbrk(0) == (uintptr_t)before + 65536,
	        "ordinary growth returns original break");
	memset(owned, 0x5a, 65536);
	unsigned char *heap = malloc(131073);
	unsigned char *mapping = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
	                              MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(heap != NULL && mapping != MAP_FAILED, "malloc and mmap after direct growth");
	memset(heap, 0x6b, 131073);
	memset(mapping, 0x7c, 65536);
	for (size_t i = 0; i < 65536; ++i)
		require(owned[i] == 0x5a && mapping[i] == 0x7c && heap[i] == 0x6b,
		        "direct, malloc and mmap data remain independent");
	puts("brk: real growth and malloc-mmap coexistence pass");
	free(heap);
	require(munmap(mapping, 65536) == 0 && sbrk(0) != (void *)-1,
	        "release library allocations without corrupting the break");
	heap = malloc(4096);
	require(heap != NULL, "later allocation after cleanup");
	memset(heap, 0x39, 4096);
	for (size_t i = 0; i < 65536; ++i) require(owned[i] == 0x5a, "reserved break bytes survive reuse");
	free(heap);
	puts("brk: allocation cleanup, reuse and reserved bytes recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
}
