/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int refuse_growth, failures;
/* Test-only namespaced build of the pinned lite_malloc.c, not an SDK API. */
void *__lite_test_malloc(size_t);
void *__real_sbrk(intptr_t);
void *__wrap_sbrk(intptr_t increment)
{
	if (refuse_growth && increment > 0) {
		failures++;
		errno = ENOMEM;
		return (void *)-1;
	}
	return __real_sbrk(increment);
}
static void report(const char *message)
{
	size_t length = strlen(message);
	while (length) {
		ssize_t done = write(STDOUT_FILENO, message, length);
		if (done <= 0) _exit(120);
		message += done;
		length -= done;
	}
}
static void require(int condition, const char *message)
{
	if (!condition) {
		report("::vm-test::fail: lite-oom: ");
		report(message);
		report("\n");
		_exit(1);
	}
}
int main(void)
{
	/* The default program selected mallocng in CI. Exercise the actual lite
	 * source separately rather than silently accepting that other backend. */
	void *(*volatile allocate)(size_t) = __lite_test_malloc;
	refuse_growth = 1;
	errno = 0;
	require(allocate(4 * 65536) == NULL && errno == ENOMEM && failures > 0,
	        "first growth failure returns ENOMEM without trapping");
	refuse_growth = 0;
	unsigned char *first = allocate(32);
	require(first != NULL, "allocation recovers after first failure");
	memset(first, 0x5a, 32);
	int previous_failures = failures;
	refuse_growth = 1;
	errno = 0;
	require(allocate(4 * 65536) == NULL && errno == ENOMEM && failures > previous_failures,
	        "later growth failure returns ENOMEM without abandoning the lock");
	refuse_growth = 0;
	unsigned char *second = allocate(16);
	require(second != NULL && second != first, "later allocation remains independent");
	memset(second, 0x6b, 16);
	for (int i = 0; i < 32; i++) require(first[i] == 0x5a, "failure preserves existing allocation");
	char cwd[64];
	require(getcwd(cwd, sizeof cwd) != NULL && !strcmp(cwd, "/"), "getcwd after failure and recovery");
	report("lite-oom: first/later growth errors, lock recovery and allocation contents pass\n");
	report("lite-oom: standard getcwd and write remain usable after exhaustion pass\n");
	report("::vm-test::pass\n");
	for (;;) sched_yield();
}
