#include "test.h"

#include <linux/futex.h>
#include <stdint.h>
#include <stdatomic.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

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
	if (syscall(SYS_futex_waitv, &waiter, 1, 0, 0,
	    CLOCK_MONOTONIC) != -1 || errno != EAGAIN)
		test_perror(mismatch_operation);

	waiter.val = 0;
	if (clock_gettime(CLOCK_MONOTONIC, &timeout))
		test_perror("clock_gettime");
	add_nanoseconds(&timeout, 1000000);
	errno = 0;
	if (syscall(SYS_futex_waitv, &waiter, 1, 0, &timeout,
	    CLOCK_MONOTONIC) != -1 || errno != ETIMEDOUT)
		test_perror(timeout_operation);
}

int main(void)
{
	_Atomic int word = 0;
	_Atomic int operand = 41;
	struct timespec timeout = { .tv_nsec = 1 };

	if (syscall(SYS_futex, &word, FUTEX_WAIT_PRIVATE, 0, &timeout) != -1)
		test_fail("futex wait unexpectedly succeeded");
	if (errno != ETIMEDOUT)
		test_perror("futex wait");
	if (syscall(SYS_futex, &word, FUTEX_WAKE_OP_PRIVATE, 0, 0, &operand,
	    FUTEX_OP(FUTEX_OP_ADD, 1, FUTEX_OP_CMP_EQ, 41)) != 0)
		test_perror("futex wake op");
	if (operand != 42)
		test_fail("futex wake op did not update its operand");
	test_waitv(FUTEX_PRIVATE_FLAG, "private futex waitv mismatch",
		"private futex waitv timeout");
	test_waitv(0, "shared futex waitv mismatch",
		"shared futex waitv timeout");

	test_pass();
}
