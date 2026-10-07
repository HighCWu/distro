/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

/* Private fixtures under CONFIG_WASM_MMAP_COPY_TEST, never application UAPI. */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255
#define WAIT_ENTERED 0x5770
#define PROCEED 0x5771

struct request {
	int fd;
	size_t page;
	_Atomic int returned;
};

static long read_mapping(int fd, size_t page)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)page,
		(unsigned long)0, (unsigned long)0);
}

static int doomed_reader(void *opaque)
{
	struct request *request = opaque;
	(void)read_mapping(request->fd, request->page);
	atomic_store(&request->returned, 1);
	return 91;
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create last-fd fixture");
	return fd;
}

static void content(const unsigned char *bytes, size_t page)
{
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("replacement mapping content mismatch");
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	char *stack = malloc(stack_size);
	struct request requests[16] = {0};
	if (!stack) test_perror("allocate last-fd child stack");
	if (page != 65536) test_fail("unexpected last-fd fixture page size");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("last-fd sentinel mmap");
	for (size_t i = 0; i < page; i++) sentinel[i] = (unsigned char)(i * 19 + 7);
	for (int round = 0; round < 8; round++) {
		for (unsigned int mode = 4; mode <= 5; mode++) {
			int fd = create(mode);
			struct request *request = &requests[round * 2 + mode - 4];
			request->fd = fd;
			request->page = page;
			/* Share the fd table, not the thread group. Closing fd removes
			 * the sole source descriptor from both processes at once. */
			pid_t pid = clone(doomed_reader, stack + stack_size,
				CLONE_VM | CLONE_FILES | SIGCHLD, request);
			if (pid == -1) test_perror("clone shared-files reader");
			if (ioctl(fd, WAIT_ENTERED, 0UL)) test_perror("wait last-fd read barrier");
			if (close(fd)) test_perror("close sole source descriptor");
			int replacement = create(0);
			if (replacement != fd) test_fail("closed source fd was not reused");
			errno = 0;
			if (ioctl(replacement, PROCEED, 0UL) != -1 || errno != ENOTTY)
				test_fail("reused fd still controlled old barrier");
			if (lseek(replacement, 31, SEEK_SET) != 31) test_perror("set replacement position");
			/* The old read remains in flight while the new file is mapped.
			 * It must not consult this reused descriptor number. */
			long result = read_mapping(replacement, page);
			if (result == -1) test_perror("map replacement before child exit");
			unsigned char *bytes = (void *)(uintptr_t)result;
			content(bytes, page);
			if (kill(pid, SIGKILL)) test_perror("kill reader without external source fd");
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("reap last-fd reader");
			if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)
				test_fail("last-fd reader did not exit through SIGKILL");
			if (atomic_load(&request->returned)) test_fail("killed last-fd request returned to callback");
			if (lseek(replacement, 0, SEEK_CUR) != 31)
				test_fail("old request changed replacement file position");
			content(bytes, page);
			for (size_t i = 0; i < page; i++)
				if (sentinel[i] != (unsigned char)(i * 19 + 7))
					test_fail("last-fd exit damaged surviving mapping");
			long fresh = read_mapping(replacement, page);
			if (fresh == -1) test_perror("map replacement after child exit");
			unsigned char *after = (void *)(uintptr_t)fresh;
			content(after, page);
			bytes[0] ^= 0xff;
			if (after[0] != 11) test_fail("replacement private copies alias");
			if (munmap(bytes, page) || munmap(after, page) || close(replacement))
				test_perror("last-fd recovery cleanup");
		}
	}
	for (size_t i = 0; i < sizeof(requests) / sizeof(requests[0]); i++)
		if (atomic_load(&requests[i].returned)) test_fail("old last-fd request resumed late");
	if (munmap(sentinel, page)) test_perror("last-fd sentinel cleanup");
	free(stack);
	test_pass();
}
