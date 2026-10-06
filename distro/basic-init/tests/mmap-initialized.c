/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/mman.h>
#include <unistd.h>

extern long __wasm_mmap_initialized(size_t,
		int (*)(void *, size_t, void *), void *);

struct request {
	size_t page;
	int fail;
	int block;
	_Atomic int entered;
	_Atomic int proceed;
	unsigned char *candidate;
	long result;
};

static int initialize(void *address, size_t length, void *argument)
{
	struct request *request = argument;
	unsigned char *bytes = address;
	if (length != 2 * request->page || (uintptr_t)address % request->page)
		test_fail("initialized backing shape");
	for (size_t i = 0; i < length; i++)
		if (bytes[i]) test_fail("initializer did not receive zeroed backing");
	request->candidate = address;
	atomic_store_explicit(&request->entered, 1, memory_order_release);
	while (request->block && !atomic_load_explicit(&request->proceed, memory_order_acquire))
		sched_yield();
	bytes[0] = 0x5a;
	bytes[request->page] = 0x6b;
	bytes[length - 1] = 0x7c;
	return request->fail;
}

static void *run(void *argument)
{
	struct request *request = argument;
	request->result = __wasm_mmap_initialized(2 * request->page, initialize, request);
	return NULL;
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	struct request request = { .page = page, .block = 1 };
	pthread_t thread;
	unsigned char *neighbor;
	if (page != 65536) test_fail("unexpected initialized mmap page size");
	if (__wasm_mmap_initialized(page, NULL, NULL) != -EINVAL)
		test_fail("missing initializer was accepted");
	if (pthread_create(&thread, NULL, run, &request))
		test_fail("initializer thread creation failed");
	while (!atomic_load_explicit(&request.entered, memory_order_acquire)) sched_yield();
	/* The initializer is deliberately paused, not doing file I/O. No published
	 * mapping owns this address, so munmap cannot release its private backing. */
	if (munmap(request.candidate, 2 * page)) test_perror("unpublished munmap");
	errno = 0;
	if (mmap(request.candidate, page, PROT_READ | PROT_WRITE,
		 MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) != MAP_FAILED ||
	    errno != ENOMEM) test_fail("unpublished backing was visible to mapping search");
	neighbor = mmap(0, page, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (neighbor == MAP_FAILED) test_perror("neighbor mmap");
	if ((uintptr_t)neighbor < (uintptr_t)request.candidate + 2 * page &&
	    (uintptr_t)request.candidate < (uintptr_t)neighbor + page)
		test_fail("neighbor overlapped unpublished backing");
	neighbor[0] = 0xa5;
	atomic_store_explicit(&request.proceed, 1, memory_order_release);
	if (pthread_join(thread, NULL)) test_fail("initializer join failed");
	if (request.result != (long)(uintptr_t)request.candidate)
		test_fail("initialized backing was not published");
	if (request.candidate[0] != 0x5a || request.candidate[page] != 0x6b ||
	    request.candidate[2 * page - 1] != 0x7c || neighbor[0] != 0xa5)
		test_fail("initialized publication content damaged");
	if (munmap(request.candidate + page, page) || munmap(request.candidate, page) ||
	    munmap(neighbor, page)) test_perror("initialized mapping cleanup");
	for (int i = 0; i < 32; i++) {
		struct request failed = { .page = page, .fail = -EIO };
		if (__wasm_mmap_initialized(2 * page, initialize, &failed) != -EIO)
			test_fail("initializer failure was not propagated");
		struct request bad = { .page = page, .fail = 1 };
		if (__wasm_mmap_initialized(2 * page, initialize, &bad) != -EIO)
			test_fail("invalid initializer result was accepted");
		struct request good = { .page = page };
		long result = __wasm_mmap_initialized(2 * page, initialize, &good);
		if (result != (long)(uintptr_t)good.candidate || munmap(good.candidate, 2 * page))
			test_fail("initialized mapping after rollback failed");
	}
	test_pass();
}
