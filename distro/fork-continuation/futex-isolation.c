/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* These retain the same numeric offsets across fork, but not the same memory.
 * Threads created only AFTER fork share each respective process's memory. */
static uint32_t first;
static int private_flag;

static long operation(uint32_t *address, int command, long count, long fourth,
		      uint32_t *other, long compare)
{
	return syscall(SYS_futex, (long)address, (long)(command | private_flag),
	               count, fourth, (long)other, compare);
}

static void *waiter(void *unused)
{
	(void)unused;
	struct timespec timeout = { .tv_sec = 30 };
	long result = operation(&first, 0 /* WAIT */, 0, (long)&timeout, NULL, 0);
	if (result) fprintf(stderr, "futex-isolation: waiter result=%ld errno=%d mode=%d\n", result, errno, private_flag);
	return (void *)(uintptr_t)(result != 0);
}

static int queued(void)
{
	struct timespec start, now;
	if (clock_gettime(CLOCK_MONOTONIC, &start)) return 0;
	for (;;) {
		/* Non-PI CMP_REQUEUE permits identical keys. Count one queued
		 * waiter without waking it or changing its address: a spurious
		 * retry must remain on the same key. Ready-before-WAIT alone
		 * would allow the cross-process check to pass before queueing. */
		long moved = operation(&first, 4 /* CMP_REQUEUE */, 0, 1, &first, 0);
		if (moved == 1) return 1;
		if (moved != 0 || clock_gettime(CLOCK_MONOTONIC, &now) ||
		    now.tv_sec - start.tv_sec >= 25) {
			fprintf(stderr, "futex-isolation: queue failed moved=%ld errno=%d\n", moved, errno);
			return 0;
		}
		sched_yield();
	}
}

static int byte(int fd, char *value, int sending)
{
	ssize_t result;
	do result = sending ? write(fd, value, 1) : read(fd, value, 1);
	while (result < 0 && errno == EINTR);
	return result == 1;
}

static int round_trip(int mode)
{
	int ready[2], release[2], status = 0;
	private_flag = mode;
	if (pipe(ready)) return 0;
	if (pipe(release)) { close(ready[0]); close(ready[1]); return 0; }
	pid_t child = fork();
	if (child == 0) {
		close(ready[0]); close(release[1]);
		pthread_t thread;
		char value = 'x';
		if (pthread_create(&thread, NULL, waiter, NULL) || !queued()) _exit(120);
		if (!byte(ready[1], &value, 1) || !byte(release[0], &value, 0)) _exit(121);
		long woke = operation(&first, 1 /* WAKE */, 1, 0, NULL, 0);
		void *result;
		int joined = pthread_join(thread, &result);
		if (joined || woke != 1 || result) {
			fprintf(stderr, "futex-isolation: child wake=%ld join=%d result=%ld\n", woke, joined, (long)result);
			_exit(122);
		}
		if (close(ready[1]) || close(release[0])) _exit(123);
		_exit(42);
	}
	close(ready[1]); close(release[0]);
	if (child < 0) { close(ready[0]); close(release[1]); return 0; }
	char value = 0;
	int received = byte(ready[0], &value, 0) && value == 'x';
	long crossed = 0;
	if (!received) crossed = -1;
	for (int n = 0; received && n < 16; n++) {
		long woke = operation(&first, 1 /* WAKE */, 1, 0, NULL, 0);
		if (woke != 0) crossed = woke;
		sched_yield();
	}
	/* Always release/reap the child, including when an old kernel incorrectly
	 * wakes it. Do not leave a blocked child behind just to report failure. */
	int released = !received || byte(release[1], &value, 1);
	int closed = close(ready[0]) == 0;
	closed &= close(release[1]) == 0;
	pid_t reaped;
	do reaped = waitpid(child, &status, 0); while (reaped < 0 && errno == EINTR);
	if (!received || !released || !closed || crossed != 0 || reaped != child ||
	    !WIFEXITED(status) || WEXITSTATUS(status) != 42) {
		fprintf(stderr, "futex-isolation: mode=%d ready=%d release=%d closed=%d cross=%ld reaped=%ld status=%d\n",
		        mode, received, released, closed, crossed, (long)reaped, status);
		return 0;
	}

	/* Positive control in the parent's own mm, after the child is gone. */
	pthread_t thread;
	if (pthread_create(&thread, NULL, waiter, NULL)) return 0;
	int moved = queued();
	long woke = operation(&first, 1 /* WAKE */, 1, 0, NULL, 0);
	void *result;
	if (!moved || woke != 1) fprintf(stderr, "futex-isolation: parent moved=%d wake=%ld errno=%d\n", moved, woke, errno);
	int joined = pthread_join(thread, &result);
	return joined == 0 && moved && woke == 1 && !result;
}

int main(void)
{
	int ok = round_trip(128 /* FUTEX_PRIVATE_FLAG */);
	if (ok) puts("futex-isolation: private queued wait and wake stay within each process pass");
	if (ok) ok = round_trip(0);
	if (ok) puts("futex-isolation: ordinary futex same-mm wake and cross-process isolation pass");
	puts(ok ? "::vm-test::pass" : "::vm-test::fail: futex-isolation: process identity or thread recovery");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return !ok;
}
