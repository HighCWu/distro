/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <linux/futex.h>
#include <stdint.h>
#include <stdatomic.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* musl uses time64 on wasm32, but SYS_futex still takes time32 there. */
#if __SIZEOF_LONG__ == 4 && defined(SYS_futex_time64)
#define FUTEX_WAIT_SYSCALL SYS_futex_time64
#else
#define FUTEX_WAIT_SYSCALL SYS_futex
#endif

_Static_assert(sizeof(_Atomic uint32_t) == 4, "Linux futex words are 32-bit");

static long wait_word(_Atomic uint32_t *word, const struct timespec *timeout)
{
	return syscall(FUTEX_WAIT_SYSCALL, (long)(uintptr_t)word,
		(long)FUTEX_WAIT_PRIVATE, 0L, (long)(uintptr_t)timeout, 0L, 0L);
}

static int64_t now_ns(void)
{
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now))
		test_perror("futex monotonic clock");
	return (int64_t)now.tv_sec * 1000000000 + now.tv_nsec;
}

static void add_nanoseconds(struct timespec *time, long nanoseconds)
{
	time->tv_nsec += nanoseconds;
	if (time->tv_nsec >= 1000000000L) {
		time->tv_sec++;
		time->tv_nsec -= 1000000000L;
	}
}

static void test_waitv(unsigned int flags, const char *mismatch_operation,
	const char *timeout_operation)
{
	_Atomic uint32_t word = 0;
	struct futex_waitv waiter = {
		.val = 1,
		.uaddr = (uintptr_t)&word,
		.flags = FUTEX_32 | flags,
	};
	struct timespec timeout;

	errno = 0;
	if (syscall(SYS_futex_waitv, (long)(uintptr_t)&waiter, 1L, 0L, 0L,
	    (long)CLOCK_MONOTONIC, 0L) != -1 || errno != EAGAIN)
		test_perror(mismatch_operation);

	waiter.val = 0;
	if (clock_gettime(CLOCK_MONOTONIC, &timeout))
		test_perror("clock_gettime");
	int64_t started = (int64_t)timeout.tv_sec * 1000000000 + timeout.tv_nsec;
	add_nanoseconds(&timeout, 20000000);
	errno = 0;
	if (syscall(SYS_futex_waitv, (long)(uintptr_t)&waiter, 1L, 0L,
	    (long)(uintptr_t)&timeout, (long)CLOCK_MONOTONIC, 0L) != -1 || errno != ETIMEDOUT)
		test_perror(timeout_operation);
	if (now_ns() - started < 15000000)
		test_fail("futex waitv timeout returned early");
}

int main(void)
{
	_Atomic uint32_t word = 0;
	_Atomic uint32_t operand = 41;
	const struct timespec timeout = { .tv_nsec = 20000000 };
	int64_t started = now_ns();

	if (wait_word(&word, &timeout) != -1)
		test_fail("futex wait unexpectedly succeeded");
	if (errno != ETIMEDOUT)
		test_perror("futex wait");
	if (now_ns() - started < 15000000)
		test_fail("futex timeout returned early");
	if (syscall(SYS_futex, (long)(uintptr_t)&word, (long)FUTEX_WAKE_OP_PRIVATE,
	    0L, 0L, (long)(uintptr_t)&operand,
	    (long)FUTEX_OP(FUTEX_OP_ADD, 1, FUTEX_OP_CMP_EQ, 41)) != 0)
		test_perror("futex wake op");
	if (operand != 42)
		test_fail("futex wake op did not update its operand");
	test_waitv(FUTEX_PRIVATE_FLAG, "private futex waitv mismatch",
		"private futex waitv timeout");
	test_waitv(0, "shared futex waitv mismatch",
		"shared futex waitv timeout");

	puts("futex ABI: relative wait, wake operation and private/shared waitv timeouts verified");
	test_pass();
}
