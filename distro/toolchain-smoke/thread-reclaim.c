// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static atomic_int destructors;
static pthread_key_t key;
static _Noreturn void fail(const char *message)
{
	dprintf(2, "thread-reclaim: %s errno=%d\n", message, errno);
	_exit(1);
}
static void require(int ok, const char *message) { if (!ok) fail(message); }

#ifdef __wasm__
#if __SIZEOF_POINTER__ == 8
__asm__(".globaltype __stack_pointer, i64\n");
#else
__asm__(".globaltype __stack_pointer, i32\n");
#endif
static _Thread_local volatile uintptr_t release_base, release_size;
static atomic_int releases;
void __real___unmapself(void *, size_t);
void __real___libc_free(void *);
_Noreturn void __wrap___unmapself(void *base, size_t size)
{
	release_base = (uintptr_t)base;
	release_size = size;
	__real___unmapself(base, size);
	fail("self-unmap unexpectedly returned");
}
void __wrap___libc_free(void *base)
{
	if ((uintptr_t)base == release_base && release_size) {
		uintptr_t sp;
		__asm__ volatile("global.get __stack_pointer\nlocal.set %0" : "=r"(sp));
		require(sp <= release_base || sp - release_base > release_size,
			"free entered while still using the released stack");
		/* The TCB is still live here. Never access this TLS after real free. */
		release_base = release_size = 0;
		atomic_fetch_add(&releases, 1);
	}
	__real___libc_free(base);
}
#endif

static void destructor(void *value)
{
	require(value == (void *)(uintptr_t)0x1234, "TLS destructor value");
	atomic_fetch_add(&destructors, 1);
}
static void *detached(void *argument)
{
	volatile unsigned char frame[1024];
	for (size_t i = 0; i < sizeof frame; i++) frame[i] = (unsigned char)i;
	require(argument == (void *)(uintptr_t)0x4567 && !pthread_setspecific(key, (void *)(uintptr_t)0x1234),
		"detached thread state");
	for (size_t i = 0; i < sizeof frame; i++)
		require(frame[i] == (unsigned char)i, "detached C frame contents");
	return NULL;
}
static void churn(void)
{
	static const size_t lengths[] = { 131072, 196608, 262144, 327680 };
	for (size_t i = 0; i < sizeof lengths / sizeof lengths[0]; i++) {
		unsigned char *p = malloc(lengths[i]);
		require(p != NULL, "concurrent allocation");
		memset(p, (int)i + 0x51, lengths[i]);
		require(p[0] == i + 0x51 && p[lengths[i] - 1] == i + 0x51, "allocation contents");
		free(p);
	}
}
static void *barrier(void *argument) { return argument; }
int main(void)
{
	require(!pthread_key_create(&key, destructor), "TLS key");
	pthread_attr_t attr;
	require(!pthread_attr_init(&attr) && !pthread_attr_setstacksize(&attr, 131072) &&
		!pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED), "detached attributes");
	for (int round = 0; round < 32; round++) {
		pthread_t thread;
		require(!pthread_create(&thread, &attr, detached, (void *)(uintptr_t)0x4567), "create detached thread");
		struct timespec limit, now;
		require(!clock_gettime(CLOCK_MONOTONIC, &limit), "release deadline");
		limit.tv_sec += 5;
		for (;;) {
#ifdef __wasm__
			int finished = atomic_load(&releases);
#else
			int finished = atomic_load(&destructors);
#endif
			if (finished == round + 1) break;
			require(!clock_gettime(CLOCK_MONOTONIC, &now) &&
				(now.tv_sec < limit.tv_sec || (now.tv_sec == limit.tv_sec && now.tv_nsec < limit.tv_nsec)),
				"bounded detached completion");
			churn();
			sched_yield();
		}
	}
	require(!pthread_attr_destroy(&attr), "attribute cleanup");
	/* Creation synchronizes with the exiting thread-list lock before a new
	 * worker becomes runnable. Join finishes this last, joinable lifecycle. */
	pthread_t thread;
	void *result = NULL;
	require(!pthread_create(&thread, NULL, barrier, (void *)(uintptr_t)0x6789) &&
		!pthread_join(thread, &result) && result == (void *)(uintptr_t)0x6789, "subsequent joinable thread");
	require(atomic_load(&destructors) == 32, "exact detached destructor count");
#ifdef __wasm__
	require(atomic_load(&releases) == 32, "exact alternate-stack release count");
	puts("thread-reclaim: each detached release switches off its stack before free pass");
#endif
	puts("thread-reclaim: detached returns, TLS destructors and concurrent allocation churn pass");
	require(!pthread_key_delete(key), "TLS key cleanup");
	churn();
	puts("thread-reclaim: subsequent joinable thread, allocation and resource cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
