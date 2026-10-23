/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include "mmap-vfs-stats.h"
#include <setjmp.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Test-only initializer replacing the optional archive member, not libc API. */
extern long __wasm_mmap_initialized(size_t, int (*)(void *, size_t, void *), void *);
__attribute__((import_module("linux_mmap_init_v1"), import_name("copy")))
extern int copy_staging(void *, size_t);
static _Atomic int action, entered, returned;
static sigjmp_buf recovery;
static int nested_fd;
static long read_mapping(int fd);
static int initialize(void *destination, size_t rounded, void *argument)
{
	(void)rounded;
	return copy_staging(destination, *(size_t *)argument);
}
long __wasm_mmap_init_v1(size_t rounded, size_t length)
{
	int mode = atomic_load(&action);
	if (mode) atomic_store(&entered, 1);
	if (mode == 1) __builtin_trap();
	if (mode == 2) {
		syscall(SYS_exit, (unsigned long)73);
		__builtin_trap();
	}
	if (mode == 3) siglongjmp(recovery, 37);
	if (mode == 4) {
		errno = 0;
		if (read_mapping(nested_fd) != -1 || errno != EBUSY)
			test_fail("nested initializer replaced outer lease");
		mmap_stats_expect(1, 1, 1);
	}
	return __wasm_mmap_initialized(rounded, initialize, &length);
}
static size_t page;
static long read_mapping(int fd)
{
	return syscall(255, (unsigned long)fd, (unsigned long)page,
		(unsigned long)0, (unsigned long)0);
}
static int child(void *argument)
{
	(void)read_mapping(*(int *)argument);
	atomic_store(&returned, 1);
	return 92;
}
static int create(void)
{
	int fd = syscall(254, (unsigned long)0);
	if (fd < 0) test_perror("create callback source");
	return fd;
}
static void normal(int fd)
{
	long result = read_mapping(fd);
	if (result == -1) test_perror("callback recovery mapping");
	unsigned char *bytes = (void *)(uintptr_t)result;
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("callback recovery content");
	if (munmap(bytes, page)) test_perror("unmap callback recovery");
}
int main(void)
{
	mmap_stats_start();
	page = sysconf(_SC_PAGESIZE);
	const size_t stack_size = 65536;
	char *stack = malloc(stack_size);
	if (!stack || page != 65536) test_fail("callback fixture setup");
	for (int round = 0; round < 4; round++) {
		for (int mode = 1; mode <= 2; mode++) {
			int fd = create();
			atomic_store(&entered, 0);
			atomic_store(&returned, 0);
			atomic_store(&action, mode);
			pid_t pid = clone(child, stack + stack_size, CLONE_VM | SIGCHLD, &fd);
			if (pid < 0) test_perror("clone callback failure");
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("wait callback failure");
			atomic_store(&action, 0);
			if (!atomic_load(&entered) || atomic_load(&returned))
				test_fail("callback failure did not leave through non-local exit");
			if (mode == 1 ? (!WIFSIGNALED(status) || WTERMSIG(status) != SIGSEGV)
				: (!WIFEXITED(status) || WEXITSTATUS(status) != 73))
				test_fail("callback failure lost trap/exit status");
			mmap_stats_wait(0, 0, 1);
			normal(fd);
			if (close(fd)) test_perror("close callback failure source");
			mmap_stats_wait(0, 0, 0);
		}
	}
	puts("mmap callback: trap SIGSEGV and nested exit preserve status and release resources pass");
	int fd = create();
	atomic_store(&action, 3);
	int result = sigsetjmp(recovery, 1);
	if (!result) {
		(void)read_mapping(fd);
		test_fail("initializer siglongjmp returned normally");
	}
	if (result != 37) test_fail("initializer lost SjLj value");
	atomic_store(&action, 0);
	mmap_stats_wait(0, 0, 1);
	normal(fd);
	nested_fd = fd;
	atomic_store(&action, 4);
	normal(fd);
	atomic_store(&action, 0);
	mmap_stats_wait(0, 0, 1);
	if (close(fd)) test_perror("close SjLj source");
	mmap_stats_wait(0, 0, 0);
	free(stack);
	puts("mmap callback: original SjLj catchpad, file release and later mapping recovery pass");
	puts("mmap callback: nested EBUSY preserves outer ownership and copy pass");
	test_pass();
}
