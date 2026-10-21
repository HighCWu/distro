// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: madvise: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
int main(void)
{
	size_t page = sysconf(_SC_PAGESIZE);
	require(page && page <= 65536, "page size");
	unsigned char *base = mmap(NULL, 3 * page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(base != MAP_FAILED, "private mapping");
	memset(base, 71, 3 * page);
	errno = EBUSY;
	require(posix_madvise(base, 3 * page, POSIX_MADV_DONTNEED) == 0 && errno == EBUSY,
		"POSIX DONTNEED is non-destructive and does not set errno");
	for (int advice = MADV_NORMAL; advice <= MADV_WILLNEED; advice++)
		require(madvise(base, 3 * page, advice) == 0, "resident hints");
	for (size_t i = 0; i < 3 * page; i++) require(base[i] == 71, "hints preserve bytes");
	errno = EBUSY;
	require(posix_madvise(base, page, -1) == EINVAL && errno == EBUSY,
		"POSIX failure returns error number without errno change");
	require(madvise(base + page, 1, MADV_DONTNEED) == 0, "discard rounded middle page");
	for (size_t i = 0; i < 3 * page; i++)
		require(base[i] == (i >= page && i < 2 * page ? 0 : 71), "discard scope and zero bytes");
	base[page] = 42;
	require(base[page] == 42 && msync(base, 3 * page, MS_SYNC) == 0, "mapping remains usable");
	errno = 0;
	require(mmap(base + page, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == MAP_FAILED && errno == EEXIST,
		"discard retains address reservation");
	puts("madvise: anonymous discard zeroes rounded pages, preserves neighbors and keeps reservations pass");
	require(madvise(NULL, 0, MADV_DONTNEED) == 0, "zero length");
	errno = 0;
	require(madvise(base + 1, 0, MADV_NORMAL) == -1 && errno == EINVAL, "unaligned zero length");
	errno = 0;
	require(madvise(base, page, -1) == -1 && errno == EINVAL, "unknown advice");
	require(munmap(base + page, page) == 0, "split mapping");
	errno = 0;
	require(madvise(base, 3 * page, MADV_NORMAL) == -1 && errno == ENOMEM, "hole rejects hint");
	require(mmap(base + page, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == base + page, "restore hole");
	memset(base, 19, 3 * page);
	require(madvise(base, 3 * page, MADV_DONTNEED) == 0, "discard adjacent records");
	for (size_t i = 0; i < 3 * page; i++) require(base[i] == 0, "adjacent records zero");
	puts("madvise: POSIX non-destructive semantics, invalid requests and adjacent records pass");
	require(munmap(base, 3 * page) == 0, "cleanup");
	errno = 0;
	require(madvise(base, page, MADV_DONTNEED) == -1 && errno == ENOMEM, "released range rejects");
	puts("madvise: released range rejection and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
