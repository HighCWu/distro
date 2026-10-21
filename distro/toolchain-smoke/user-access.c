// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/mman.h>
#include <unistd.h>

static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: user-access: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
/* Raw standard syscalls keep the NULL arguments opaque to compiler builtin
 * assumptions about libc read/write's nonnull access annotations. */
static long call(long nr, long a, long b, long c, long d, long e, long f)
{
	return syscall(nr, a, b, c, d, e, f);
}

static void check_partial_copy(int *fds)
{
	volatile unsigned char *tail;
#ifdef __wasm__
	/* Reserve a fresh page instead of corrupting an active C stack or heap
	 * object at the module's old memory end. This is a platform test only. */
	size_t old_pages = __builtin_wasm_memory_grow(0, 1);
	require(old_pages != (size_t)-1, "reserve boundary test page");
	uint64_t end = ((uint64_t)old_pages + 1) * 65536;
	tail = (void *)(uintptr_t)(end - 2);
	char path[] = "/user-access-copy.XXXXXX";
#else
	long page = sysconf(_SC_PAGESIZE);
	require(page > 0, "native page size");
	unsigned char *mapping = mmap(NULL, (size_t)page * 2, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	require(mapping != MAP_FAILED && mprotect(mapping + page, (size_t)page, PROT_NONE) == 0,
		"native inaccessible boundary");
	tail = mapping + page - 2;
	char path[] = "/tmp/user-access-copy.XXXXXX";
#endif
	int fd = mkstemp(path);
	require(fd >= 0 && unlink(path) == 0, "anonymous regular file fixture");
	char bytes[4];
	require(write(fd, "ABCD", 4) == 4 && lseek(fd, 0, SEEK_SET) == 0, "seed regular file");
	tail[0] = 'T'; tail[1] = 'U';
	require(call(SYS_read, fd, (long)tail, 4, 0, 0, 0) == 2 && tail[0] == 'A' && tail[1] == 'B',
		"partial regular file read and bytes");
	require(lseek(fd, 0, SEEK_CUR) == 2 && read(fd, bytes, 2) == 2 && memcmp(bytes, "CD", 2) == 0,
		"partial read advances only copied bytes");
	tail[0] = 'T'; tail[1] = 'U';
	require(lseek(fd, 0, SEEK_SET) == 0 && call(SYS_write, fd, (long)tail, 4, 0, 0, 0) == 2 &&
		lseek(fd, 0, SEEK_CUR) == 2, "partial regular file write and position");
	require(lseek(fd, 0, SEEK_SET) == 0 && read(fd, bytes, 4) == 4 && memcmp(bytes, "TUCD", 4) == 0,
		"partial write preserves uncopied file suffix");
	require(close(fd) == 0, "close regular file fixture");
	require(write(fds[1], "WXYZ", 4) == 4, "queue pipe boundary bytes");
	errno = 0;
	require(call(SYS_read, fds[0], (long)tail, 4, 0, 0, 0) == -1 && errno == EFAULT &&
		tail[0] == 'W' && tail[1] == 'X', "pipe read fault still copies valid user prefix");
	require(read(fds[0], bytes, 4) == 4 && memcmp(bytes, "WXYZ", 4) == 0,
		"faulted pipe read preserves the whole original queue");
	errno = 0;
	require(call(SYS_write, fds[1], (long)tail, 4, 0, 0, 0) == -1 && errno == EFAULT,
		"pipe write rejects incomplete source buffer");
	errno = 0;
	require(read(fds[0], bytes, 1) == -1 && errno == EAGAIN, "faulted pipe write publishes no bytes");
#ifndef __wasm__
	require(munmap(mapping, (size_t)page * 2) == 0, "release native boundary fixture");
#endif
	puts("user-access: partial boundary copies preserve file positions, suffixes and pipe accounting pass");
}

#ifdef USER_ACCESS_UPPER32
#if !defined(__wasm__) || __SIZEOF_POINTER__ != 4
#error USER_ACCESS_UPPER32 requires the dedicated wasm32 target
#endif
static void check_upper_half(int *fds)
{
	/* Explicit CI-only profile: reserve address range, touch only this fresh
	 * high page. Do not turn ordinary smoke tests into large-memory requests. */
	size_t pages = __builtin_wasm_memory_size(0);
	const size_t desired = 32769; /* 2 GiB + one page */
	require(pages < desired, "upper-half page is fresh");
	require(__builtin_wasm_memory_grow(0, desired - pages) == pages,
		"reserve wasm32 upper-half address range");
	volatile unsigned char *bytes = (void *)(uintptr_t)UINT32_C(0x80000040);
	bytes[0] = 'G'; bytes[1] = 'H';
	require(call(SYS_write, fds[1], (long)bytes, 2, 0, 0, 0) == 2, "upper-half write source");
	bytes[0] = 0; bytes[1] = 0;
	require(call(SYS_read, fds[0], (long)bytes, 2, 0, 0, 0) == 2 &&
		bytes[0] == 'G' && bytes[1] == 'H', "upper-half read destination");
	struct utsname *name = (void *)(uintptr_t)UINT32_C(0x80000040);
	require(uname(name) == 0 && strcmp(name->sysname, "Linux") == 0, "upper-half structure output");
	volatile int *first = (void *)(uintptr_t)UINT32_C(0x80000400);
	volatile int *second = (void *)(uintptr_t)UINT32_C(0x80000800);
	*first = 0; *second = 7;
	require(call(SYS_futex, (long)first, 5 | 128, 0, 0, (long)second,
		(1L << 28) | (1L << 12) | 7) == 0 && *first == 0 && *second == 8,
		"upper-half futex atomic operands");
	puts("user-access: wasm32 upper-half pipe buffers, structure output and atomic operands pass");
}
#endif

int main(void)
{
	int fds[2];
	char byte = 0;
	require(pipe2(fds, O_NONBLOCK | O_CLOEXEC) == 0, "create pipe");
	require(write(fds[1], "R", 1) == 1, "queue readable byte");
	errno = 0;
	require(call(SYS_read, fds[0], 0, 1, 0, 0, 0) == -1 && errno == EFAULT, "NULL read buffer");
	require(read(fds[0], &byte, 1) == 1 && byte == 'R', "failed read preserves queued byte");
	errno = 0;
	require(call(SYS_write, fds[1], 0, 1, 0, 0, 0) == -1 && errno == EFAULT, "NULL write buffer");
	errno = 0;
	require(read(fds[0], &byte, 1) == -1 && errno == EAGAIN, "failed write queues no bytes");
	require(call(SYS_read, fds[0], 0, 0, 0, 0, 0) == 0 &&
		call(SYS_write, fds[1], 0, 0, 0, 0, 0) == 0, "zero length permits NULL buffer");
	errno = 0;
	require(call(SYS_openat, AT_FDCWD, 0, O_RDONLY, 0, 0, 0) == -1 && errno == EFAULT, "NULL pathname");
	errno = 0;
	require(call(SYS_uname, 0, 0, 0, 0, 0, 0) == -1 && errno == EFAULT, "NULL structure output");
	int word = 0;
	/* Linux UAPI: FUTEX_WAKE_OP_PRIVATE and ADD 1 / compare equal 0. This
	 * non-waiting command uses the ordinary futex number at both widths. */
	errno = 0;
	require(call(SYS_futex, (long)&word, 5 | 128, 0, 0, 0, (1L << 28) | (1L << 12)) == -1 &&
		errno == EFAULT && word == 0, "NULL futex atomic target");
	puts("user-access: NULL data, pathname, structure and atomic targets reject without side effects pass");
	check_partial_copy(fds);
#ifdef USER_ACCESS_UPPER32
	check_upper_half(fds);
#endif
	struct utsname name;
	require(uname(&name) == 0 && strcmp(name.sysname, "Linux") == 0, "valid structure retry");
	require(write(fds[1], "S", 1) == 1 && read(fds[0], &byte, 1) == 1 && byte == 'S', "valid pipe retry");
	require(close(fds[0]) == 0 && close(fds[1]) == 0, "close pipe");
	puts("user-access: zero lengths, valid retries and descriptor recovery pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
