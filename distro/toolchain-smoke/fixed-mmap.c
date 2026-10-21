// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: fixed-mmap: %s errno=%d\n", message, errno);
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
	const int flags = MAP_PRIVATE | MAP_ANONYMOUS;
	require(page && page <= 65536, "page size");
	unsigned char *base = mmap(NULL, 6 * page, PROT_READ | PROT_WRITE, flags, -1, 0);
	require(base != MAP_FAILED, "initial mapping");
	memset(base, 71, 6 * page);
	require(mmap(base + 2 * page, 1, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0) == base + 2 * page,
		"middle-page replacement");
	for (size_t i = 0; i < 6 * page; i++)
		require(base[i] == (i >= 2 * page && i < 3 * page ? 0 : 71), "replacement zeroes only selected page");
	require(mmap(base + page, 4 * page, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0) == base + page,
		"replacement crosses split records");
	for (size_t i = 0; i < 6 * page; i++)
		require(base[i] == (i >= page && i < 5 * page ? 0 : 71), "cross-record scope");
	puts("fixed-mmap: middle replacement, zero initialization and cross-record neighbor preservation pass");
	base[2 * page] = 42;
	errno = 0;
	require(mmap(base + 2 * page, page, PROT_READ | PROT_WRITE,
		flags | MAP_FIXED | MAP_FIXED_NOREPLACE, -1, 0) == MAP_FAILED && errno == EEXIST,
		"NOREPLACE wins over FIXED");
	require(base[2 * page] == 42, "NOREPLACE failure preserves bytes");
	require(munmap(base + 2 * page, page) == 0, "make hole");
	require(mmap(base + 2 * page, page, PROT_READ | PROT_WRITE,
		flags | MAP_FIXED | MAP_FIXED_NOREPLACE, -1, 0) == base + 2 * page, "NOREPLACE fills hole");
	errno = 0;
	require(mmap(base + 1, page, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0)
		== MAP_FAILED && errno == EINVAL, "misalignment rejects");
#ifdef __wasm__
	/* Native Linux permits replacing a stack; Wasm must not touch its malloc or stack arenas. */
	uintptr_t stack_page = (uintptr_t)&page & -(uintptr_t)page;
	errno = 0;
	require(mmap((void *)stack_page, page, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0)
		== MAP_FAILED && errno == ENOMEM, "non-mmap backing rejects");
	errno = 0;
	require(mmap(base, 9 * page, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0)
		== MAP_FAILED && errno == ENOMEM, "outside reserved backing rejects");
	require(base[0] == 71 && base[5 * page] == 71, "rejected replacement preserves original");
#endif
	puts("fixed-mmap: NOREPLACE priority, hole reuse and invalid replacement recovery pass");
	require(mmap(base, 6 * page, PROT_READ | PROT_WRITE, flags | MAP_FIXED, -1, 0) == base,
		"whole backing replacement retains lifetime");
	for (size_t i = 0; i < 6 * page; i++) require(base[i] == 0, "whole replacement zero");
	base[5 * page] = 0x81;
	require(msync(base, 6 * page, MS_SYNC) == 0 && base[5 * page] == 0x81, "replacement remains live");
	require(munmap(base, 6 * page) == 0, "cleanup");
	puts("fixed-mmap: last old reference replacement, continued use and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
