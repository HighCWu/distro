/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: vmsplice: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

static long transfer(int fd, struct iovec *iov, size_t count, unsigned flags)
{
	return syscall(SYS_vmsplice, (long)fd, (long)iov, (long)count,
	               (long)flags, 0L, 0L);
}

static void pair(int p[2])
{
	require(pipe2(p, O_NONBLOCK | O_CLOEXEC) == 0, "create pipe");
}

static void finish(int p[2])
{
	require(close(p[0]) == 0 && close(p[1]) == 0, "close pipe descriptors");
}

int main(void)
{
	unsigned char source[192], output[192], expected[192];
	for (unsigned n = 0; n < sizeof source; n++) source[n] = (unsigned char)(n * 19 + 7);
	memcpy(expected, source, sizeof source);
	struct iovec in[] = { { source, 31 }, { NULL, 0 }, { source + 31, 142 } };
	int p[2], q[2];
	pair(p); pair(q);
	require(transfer(p[1], in, 3, SPLICE_F_NONBLOCK | SPLICE_F_MORE) == 173,
	        "vectored user bytes enter pipe");
#ifdef __wasm__
	/* This implementation copies; unlike a pinned-page architecture it must
	 * retain no alias into user linear memory after returning. */
	memset(source, 0, sizeof source);
#endif
	require(syscall(SYS_tee, (long)p[0], (long)q[1], 173L,
	                (long)SPLICE_F_NONBLOCK, 0L, 0L) == 173 &&
	        read(q[0], output, 173) == 173 && !memcmp(output, expected, 173),
	        "tee retains correct pipe-owned payload");
	require(syscall(SYS_splice, (long)p[0], 0L, (long)q[1], 0L,
	                173L, (long)SPLICE_F_NONBLOCK) == 173, "splice between pipes");
	memset(output, 0, sizeof output);
	struct iovec out[] = { { output, 17 }, { output + 17, 156 } };
	require(transfer(q[0], out, 2, SPLICE_F_NONBLOCK) == 173 &&
	        !memcmp(output, expected, 173), "pipe to vectored user memory");
	require(transfer(p[0], out, 2, SPLICE_F_NONBLOCK) == -1 && errno == EAGAIN,
	        "empty nonblocking pipe");
	finish(p); finish(q);
	puts("vmsplice: vectored copies, tee, splice and reverse transfer pass");

	long page_size = sysconf(_SC_PAGESIZE);
	require(page_size > 0, "page size");
	unsigned char *page = NULL, *drained = malloc((size_t)page_size);
	require(posix_memalign((void **)&page, (size_t)page_size, (size_t)page_size) == 0 && drained,
	        "aligned transfer storage");
	memset(page, 0x69, (size_t)page_size);
	struct iovec block = { page, (size_t)page_size };
	pair(p);
	int capacity = fcntl(p[1], F_GETPIPE_SZ);
	require(capacity >= page_size && capacity % page_size == 0, "pipe capacity");
	for (long n = 0; n < capacity / page_size; n++)
		require(transfer(p[1], &block, 1, SPLICE_F_NONBLOCK) == page_size, "fill pipe slots");
	require(transfer(p[1], &block, 1, SPLICE_F_NONBLOCK) == -1 && errno == EAGAIN,
	        "full pipe preserves nonblocking backpressure");
	for (long n = 0; n < capacity / page_size; n++)
		require(read(p[0], drained, (size_t)page_size) == page_size &&
		        !memcmp(drained, page, (size_t)page_size), "drain intact page");
	require(transfer(p[1], &block, 1, SPLICE_F_NONBLOCK | SPLICE_F_GIFT) == page_size &&
	        read(p[0], drained, (size_t)page_size) == page_size &&
	        !memcmp(drained, page, (size_t)page_size), "gift request preserves payload");
	finish(p);
	free(drained); free(page);
	puts("vmsplice: bounded pipe capacity, nonblocking backpressure and gift request pass");

	pair(p);
	require(transfer(-1, in, 3, 0) == -1 && errno == EBADF, "bad descriptor");
	require(transfer(p[1], in, 3, 0x80000000U) == -1 && errno == EINVAL, "unknown flags");
	require(transfer(p[1], NULL, 0, 0) == 0, "empty vector");
#ifdef __wasm__
	uintptr_t outside = (uintptr_t)__builtin_wasm_memory_size(0) * 65536 + 32;
	struct iovec fault[] = { { expected, 31 }, { (void *)outside, 19 } };
	require(transfer(p[1], fault, 2, SPLICE_F_NONBLOCK) == 31 &&
	        read(p[0], output, 31) == 31 && !memcmp(output, expected, 31),
	        "valid prefix is returned before out-of-memory user range");
	require(transfer(p[1], fault + 1, 1, SPLICE_F_NONBLOCK) == -1 && errno == EFAULT,
	        "unavailable user range leaves no pipe payload");
	require(read(p[0], output, 1) == -1 && errno == EAGAIN, "fault published no stale page data");
#endif
	require(signal(SIGPIPE, SIG_IGN) != SIG_ERR && close(p[0]) == 0, "ignore broken-pipe signal");
	require(transfer(p[1], in, 3, SPLICE_F_NONBLOCK) == -1 && errno == EPIPE,
	        "broken pipe returns EPIPE");
	require(close(p[1]) == 0, "broken-pipe descriptor close");
	pair(p);
	struct iovec recover = { expected, 173 };
	require(transfer(p[1], &recover, 1, SPLICE_F_NONBLOCK) == 173 &&
	        read(p[0], output, 173) == 173 && !memcmp(output, expected, 173), "recovery after failures");
	finish(p);
	puts("vmsplice: error boundaries, cleanup and later transfer recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
