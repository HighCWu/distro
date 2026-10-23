/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error This checks Wasm shared memory growth, not a native address-space allocator
#endif
#include "test.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Atomic unsigned command, ready;
static _Atomic uintptr_t published;
static int primary;
static void *grower(void *argument)
{
	(void)argument;
	for (unsigned round = 1; round <= 2; round++) {
		while (atomic_load_explicit(&command, memory_order_acquire) != round) sched_yield();
		size_t old = __builtin_wasm_memory_grow(0, 1);
		uintptr_t base = old == SIZE_MAX ? 0 : (uintptr_t)old * 65536;
		if (base) {
			unsigned char *bytes = (void *)base;
			for (unsigned i = 0; i < 32; i++) bytes[i] = (unsigned char)(i * 17 + 3);
			*(uint32_t *)(base + 256) = 7;
		}
		atomic_store_explicit(&published, base, memory_order_relaxed);
		atomic_store_explicit(&ready, round, memory_order_release);
	}
	while (atomic_load_explicit(&command, memory_order_acquire) != 3) sched_yield();
	return NULL;
}
static uintptr_t request(unsigned round)
{
	atomic_store_explicit(&command, round, memory_order_release);
	while (atomic_load_explicit(&ready, memory_order_acquire) != round) sched_yield();
	uintptr_t address = atomic_load_explicit(&published, memory_order_relaxed);
	if (!address) test_fail("remote memory.grow failed");
	return address;
}
int main(void)
{
	int descriptors[2];
	if (pipe(descriptors)) test_perror("growth pipe");
	pthread_t thread;
	if (pthread_create(&thread, NULL, grower, NULL)) test_fail("growth pthread_create");
	uintptr_t first = request(1);
	/* No user allocation follows grow until both checks finish: these two
	 * extra pages are temporary raw capacity, not registered mmap backing. */
	if (write(descriptors[1], (void *)first, 32) != 32 ||
	    read(descriptors[0], (void *)(first + 128), 32) != 32)
		test_perror("copy through newly grown user page");
	for (unsigned i = 0; i < 32; i++)
		if (*(unsigned char *)(first + 128 + i) != (unsigned char)(i * 17 + 3))
			test_fail("new-page pipe data mismatch");
	uintptr_t second = request(2);
	/* Linux FUTEX_WAKE_OP|PRIVATE, ADD3/CMP_EQ7; all args are machine words.
	 * The second fresh page has not been passed through another user copy. */
	unsigned long operation = (1UL << 28) | (3UL << 12) | 7UL;
	if (syscall(SYS_futex, (unsigned long)&primary, 5UL | 128UL, 0UL,
	            0UL, (unsigned long)(second + 256), operation) != 0)
		test_perror("wake-op in newly grown user page");
	if (*(uint32_t *)(second + 256) != 10) test_fail("new-page atomic operation mismatch");
	atomic_store_explicit(&command, 3, memory_order_release);
	if (pthread_join(thread, NULL)) test_fail("growth pthread_join");
	if (close(descriptors[0]) || close(descriptors[1])) test_perror("growth pipe close");
	puts("shared-growth: remote memory.grow, pipe user copies and data integrity pass");
	puts("shared-growth: second grow, atomic wake-op, thread join and cleanup pass");
	test_pass();
}
