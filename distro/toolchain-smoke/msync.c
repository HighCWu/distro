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
	printf("::vm-test::fail: msync: %s errno=%d\n", message, errno);
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
	require(base != MAP_FAILED, "private anonymous mapping");
	memset(base, 71, 3 * page);
	const int modes[] = {0, MS_SYNC, MS_ASYNC, MS_INVALIDATE,
		MS_SYNC | MS_INVALIDATE, MS_ASYNC | MS_INVALIDATE};
	for (unsigned i = 0; i < sizeof modes / sizeof modes[0]; i++)
		require(msync(base, page + 1, modes[i]) == 0, "valid private range and flags");
	for (size_t i = 0; i < 3 * page; i++) require(base[i] == 71, "sync does not discard private data");
	require(msync(NULL, 0, MS_SYNC) == 0, "empty aligned interval");
	errno = 0;
	require(msync(base + 1, 0, MS_SYNC) == -1 && errno == EINVAL, "unaligned zero range");
	errno = 0;
	require(msync(base, page, MS_SYNC | MS_ASYNC) == -1 && errno == EINVAL, "conflicting flags");
	errno = 0;
	require(msync(base, page, 8) == -1 && errno == EINVAL, "unknown flags");
	errno = 0;
	require(msync(NULL, page, MS_SYNC) == -1 && errno == ENOMEM, "nonempty unmapped interval");
	puts("msync: private range, flags, page rounding and data preservation pass");
	require(munmap(base + page, page) == 0, "create mapping hole");
	errno = 0;
	require(msync(base, 3 * page, MS_SYNC) == -1 && errno == ENOMEM, "hole rejects whole interval");
	require(msync(base, page, MS_SYNC) == 0 && msync(base + 2 * page, page, MS_ASYNC) == 0,
		"remaining pieces are valid");
	require(mmap(base + page, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == base + page,
		"restore exact hole");
	require(msync(base, 3 * page, MS_SYNC | MS_INVALIDATE) == 0,
		"adjacent records cover the complete interval");
	require(base[0] == 71 && base[page] == 0 && base[2 * page] == 71, "no fabricated write or discard");
	puts("msync: holes reject and adjacent live records recover without data changes pass");
	require(munmap(base, 3 * page) == 0, "release mapping");
	errno = 0;
	require(msync(base, page, MS_SYNC) == -1 && errno == ENOMEM, "freed backing is not a live mapping");
	puts("msync: released range rejection and cleanup pass");
#ifndef __wasm__
	/* Native parity only: Linux does not write dirty MAP_PRIVATE bytes back. */
	char path[] = "/tmp/private-msync.XXXXXX";
	int fd = mkstemp(path);
	unsigned char byte = 0x42;
	require(fd >= 0 && unlink(path) == 0 && ftruncate(fd, page) == 0 && write(fd, &byte, 1) == 1,
		"native private file fixture");
	unsigned char *copy = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
	require(copy != MAP_FAILED, "native private file mapping");
	copy[0] = 0x55;
	require(msync(copy, page, MS_SYNC) == 0 && pread(fd, &byte, 1, 0) == 1 && byte == 0x42 &&
		copy[0] == 0x55, "private file sync does not publish dirty bytes");
	require(munmap(copy, page) == 0 && close(fd) == 0, "native parity fixture cleanup");
	puts("native msync parity: private file dirty bytes do not write back");
#endif
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
