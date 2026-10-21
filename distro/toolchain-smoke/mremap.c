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
	printf("::vm-test::fail: mremap: %s errno=%d\n", message, errno);
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
	unsigned char *original = mmap(NULL, 2 * page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(original != MAP_FAILED, "anonymous source");
	memset(original, 37, 2 * page);
	require(mremap(original, 2 * page, page, 0) == original, "shrink in place");
	require(mremap(original, page, 2 * page, 0) == original, "regrow in place");
	for (size_t i = 0; i < page; i++) require(original[i] == 37, "preserve original prefix");
	for (size_t i = page; i < 2 * page; i++) require(original[i] == 0, "regrown tail is zero");
	puts("mremap: shrink, in-place growth, prefix preservation and zero tail pass");
	unsigned char *neighbor = mmap(original + 2 * page, 2 * page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
	require(neighbor == original + 2 * page, "reserve adjacent direct mapping");
	memset(neighbor, 91, 2 * page);
	errno = 0;
	require(mremap(original, 2 * page, 4 * page, 0) == MAP_FAILED && errno == ENOMEM,
		"no-move growth cannot overwrite neighbor");
	errno = 0;
	require(mremap(original, 2 * page, 0, MREMAP_MAYMOVE) == MAP_FAILED && errno == EINVAL,
		"reject zero target length");
#ifdef __wasm__
	errno = 0;
	require(mremap(original, 2 * page, 2 * page, MREMAP_FIXED | MREMAP_MAYMOVE, neighbor)
		== MAP_FAILED && errno == EOPNOTSUPP, "fixed replacement remains unsupported");
#endif
	require(original[0] == 37 && neighbor[0] == 91, "failed requests preserve both mappings");
	unsigned char *moved = mremap(original, 2 * page, 4 * page, MREMAP_MAYMOVE);
	require(moved != MAP_FAILED && moved != original, "move blocked growth");
	for (size_t i = 0; i < page; i++) require(moved[i] == 37, "moved prefix");
	for (size_t i = page; i < 4 * page; i++) require(moved[i] == 0, "moved zero tail");
	for (size_t i = 0; i < 2 * page; i++) require(neighbor[i] == 91, "neighbor isolation");
	puts("mremap: refused growth, anonymous relocation and neighboring mapping isolation pass");
	require(munmap(moved, 4 * page) == 0 && munmap(neighbor, 2 * page) == 0, "release mappings");
	unsigned char *retry = mmap(NULL, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(retry != MAP_FAILED && retry[0] == 0 && munmap(retry, page) == 0, "later mapping recovery");
	puts("mremap: cleanup and subsequent mapping recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
