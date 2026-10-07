/* SPDX-License-Identifier: MIT */
#pragma once
#include "test.h"
#include <time.h>
#include <unistd.h>

/* Private scalar queries, not a coherent concurrent snapshot or public UAPI. */
#define MMAP_STATS_TEST_NR 257

static int mmap_stats_match(long requests, long staging, long files)
{
	long expected[] = { requests, staging, files };
	for (unsigned long i = 0; i < 3; i++) {
		long actual = syscall(MMAP_STATS_TEST_NR, i);
		if (actual < 0) test_perror("query VFS resource gauge");
		if (actual != expected[i]) return 0;
	}
	return 1;
}

static void mmap_stats_expect(long requests, long staging, long files)
{
	if (!mmap_stats_match(requests, staging, files))
		test_fail("VFS resource gauge mismatch at stable barrier");
}

static void mmap_stats_start(void)
{
	errno = 0;
	if (syscall(MMAP_STATS_TEST_NR, (unsigned long)3) != -1 || errno != EINVAL)
		test_fail("invalid resource gauge selector accepted");
	mmap_stats_expect(0, 0, 0);
}

static void mmap_stats_wait(long requests, long staging, long files)
{
	struct timespec start, now;
	if (clock_gettime(CLOCK_MONOTONIC, &start)) test_perror("resource gauge clock");
	while (!mmap_stats_match(requests, staging, files)) {
		if (clock_gettime(CLOCK_MONOTONIC, &now)) test_perror("resource gauge clock");
		if (now.tv_sec - start.tv_sec > 2)
			test_fail("VFS resources did not return to expected baseline");
		/* Final fput may run as deferred task work or on a worker. */
		sched_yield();
	}
}
