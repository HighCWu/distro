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
static void subrange(size_t page)
{
	unsigned char *base = mmap(NULL, 6 * page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(base != MAP_FAILED, "subrange source");
	for (size_t i = 0; i < 6; i++) memset(base + i * page, 11 + i, page);
	require(mremap(base + page, 2 * page, page, 0) == base + page,
		"shrink middle subrange without discarding unrequested suffix");
	require(mmap(base + 2 * page, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == base + 2 * page,
		"reuse exact shrink hole");
	unsigned char *moved = mremap(base + 4 * page, page, 2 * page, MREMAP_MAYMOVE);
	require(moved != MAP_FAILED && moved != base + 4 * page, "relocate interior subrange");
	for (size_t i = 0; i < 2 * page; i++)
		require(moved[i] == (i < page ? 15 : 0), "interior moved data and zero expansion");
	require(mmap(base + 4 * page, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == base + 4 * page,
		"reuse relocated hole");
	for (size_t i = 0; i < 6 * page; i++) {
		size_t index = i / page;
		require(base[i] == (index == 2 || index == 4 ? 0 : 11 + index),
			"both retained sides and fresh holes");
	}
	for (size_t i = 0; i < 6; i++) if (i != 2 && i != 4) {
		errno = 0;
		require(mmap(base + i * page, page, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0) == MAP_FAILED &&
			errno == EEXIST, "retained ranges remain registered, not just readable bytes");
	}
	require(munmap(moved, 2 * page) == 0 && munmap(base, 6 * page) == 0,
		"subrange metadata and backing cleanup");
	puts("mremap: subrange shrink and relocation preserve both sides and reusable holes pass");
}

static void fixed_move(size_t page)
{
	const int flags = MAP_PRIVATE | MAP_ANONYMOUS;
	const int move = MREMAP_FIXED | MREMAP_MAYMOVE;
	unsigned char *base = mmap(NULL, 8 * page, PROT_READ | PROT_WRITE, flags, -1, 0);
	require(base != MAP_FAILED, "fixed arena");
	for (size_t i = 0; i < 8; i++) memset(base + i * page, 10 + i, page);
	require(mremap(base + page, 2 * page, 3 * page, move, base + 5 * page) == base + 5 * page,
		"fixed interior growth");
	for (size_t i = 0; i < 3 * page; i++)
		require(base[5 * page + i] == (i < 2 * page ? 11 + i / page : 0), "fixed copy and zero tail");
	require(base[0] == 10 && base[3 * page] == 13 && base[4 * page] == 14,
		"fixed movement preserves both source neighbors");
	require(mmap(base + page, 2 * page, PROT_READ | PROT_WRITE,
		flags | MAP_FIXED_NOREPLACE, -1, 0) == base + page, "reuse fixed move source hole");
	require(mremap(base + 5 * page, 3 * page, page, move, base + 3 * page) == base + 3 * page,
		"fixed shrink and destination replacement");
	require(base[3 * page] == 11 && base[4 * page] == 14 && base[0] == 10,
		"shrink copies prefix without touching neighbors");
	errno = 0;
	require(mremap(base + 3 * page, page, page, move, base + 3 * page) == MAP_FAILED && errno == EINVAL,
		"fixed overlap rejects");
	require(base[3 * page] == 11 && munmap(base, 8 * page) == 0, "fixed arena cleanup");
	puts("mremap: fixed same-backing growth, shrink, neighbor isolation and source-hole reuse pass");
	unsigned char *source = mmap(NULL, 10 * page, PROT_READ | PROT_WRITE, flags, -1, 0);
	unsigned char *destination = mmap(NULL, 12 * page, PROT_READ | PROT_WRITE, flags, -1, 0);
	require(source != MAP_FAILED && destination != MAP_FAILED, "fixed independent backing");
	memset(source, 37, 10 * page);
	memset(destination, 91, 12 * page);
	require(mremap(source, 10 * page, 12 * page, move, destination) == destination,
		"fixed move releases complete source backing");
	for (size_t i = 0; i < 12 * page; i++)
		require(destination[i] == (i < 10 * page ? 37 : 0), "cross-backing copy and expansion");
	require(msync(destination, 12 * page, MS_SYNC) == 0 && munmap(destination, 12 * page) == 0,
		"new destination remains registered and cleanup succeeds");
	puts("mremap: fixed cross-backing replacement, zero expansion and full-source cleanup pass");
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
	errno = 0;
	require(mremap(original, 2 * page, 2 * page, MREMAP_FIXED | MREMAP_MAYMOVE, original + page)
		== MAP_FAILED && errno == EINVAL, "overlapping fixed request rejects");
	require(original[0] == 37 && neighbor[0] == 91, "failed requests preserve both mappings");
	unsigned char *moved = mremap(original, 2 * page, 4 * page, MREMAP_MAYMOVE);
	require(moved != MAP_FAILED && moved != original, "move blocked growth");
	for (size_t i = 0; i < page; i++) require(moved[i] == 37, "moved prefix");
	for (size_t i = page; i < 4 * page; i++) require(moved[i] == 0, "moved zero tail");
	for (size_t i = 0; i < 2 * page; i++) require(neighbor[i] == 91, "neighbor isolation");
	puts("mremap: refused growth, anonymous relocation and neighboring mapping isolation pass");
	require(munmap(moved, 4 * page) == 0 && munmap(neighbor, 2 * page) == 0, "release mappings");
	subrange(page);
	fixed_move(page);
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
