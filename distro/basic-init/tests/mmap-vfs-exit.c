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
#include "mmap-vfs-stats.h"

/* Private fixture slots only; clone uses the existing callback convention. */
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
	/* SIGKILL must terminate this task on syscall exit, not return a partial
	 * mapping or an error to its user callback. Memory is shared so the
	 * surviving controller can observe any unexpected callback return. */
	(void)read_mapping(request->fd, request->page);
	atomic_store(&request->returned, 1);
	return 91;
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create exit fixture");
	return fd;
}

static void check_mapping(int fd, size_t page)
{
	long result = read_mapping(fd, page);
	if (result == -1) test_perror("read after fatal child exit");
	unsigned char *bytes = (void *)(uintptr_t)result;
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("post-exit mapping content mismatch");
	if (munmap(bytes, page)) test_perror("post-exit mapping cleanup");
}

int main(void)
{
	mmap_stats_start();
	const size_t stack_size = 64 * 1024;
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	char *stack = malloc(stack_size);
	struct request requests[16] = {0};
	if (!stack) test_perror("allocate exit child stack");
	if (page != 65536) test_fail("unexpected exit fixture page size");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("exit sentinel mmap");
	for (size_t i = 0; i < page; i++) sentinel[i] = (unsigned char)(i * 19 + 7);
	for (int round = 0; round < 8; round++) {
		for (unsigned int mode = 4; mode <= 5; mode++) {
			int fd = create(mode);
			if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set exit fixture position");
			struct request *request = &requests[round * 2 + mode - 4];
			request->fd = fd;
			request->page = page;
			/* Shared mm, separate thread group and fd table: SIGKILL must
			 * not kill the controller. This is not a private memory snapshot. */
			pid_t pid = clone(doomed_reader, stack + stack_size,
				CLONE_VM | SIGCHLD, request);
			if (pid == -1) test_perror("clone doomed reader");
			if (ioctl(fd, WAIT_ENTERED, 0UL)) test_perror("wait exit read barrier");
			mmap_stats_expect(1, 1, 1);
			if (kill(pid, SIGKILL)) test_perror("kill blocked reader");
			/* No PROCEED before waitpid: only fatal signal delivery can end
			 * the pending read. The runner's watchdog bounds stuck exits. */
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("reap killed reader");
			mmap_stats_wait(0, 0, 1);
			if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL)
				test_fail("blocked reader did not exit through SIGKILL");
			if (atomic_load(&request->returned)) test_fail("killed read returned to user callback");
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("killed read changed shared file position");
			if (ioctl(fd, PROCEED, 0UL) || ioctl(fd, PROCEED, 0UL))
				test_perror("post-exit barrier release");
			for (size_t i = 0; i < page; i++)
				if (sentinel[i] != (unsigned char)(i * 19 + 7))
					test_fail("fatal read exit damaged surviving mapping");
			if (mode == 4) check_mapping(fd, page);
			else {
				errno = 0;
				if (read_mapping(fd, page) != -1 || errno != EIO)
					test_fail("surviving partial-error fixture lost EIO");
			}
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("post-exit retry changed position");
			if (close(fd)) test_perror("close exit fixture");
			int recovery = create(0);
			check_mapping(recovery, page);
			if (close(recovery)) test_perror("close exit recovery fixture");
			mmap_stats_wait(0, 0, 0);
		}
	}
	for (size_t i = 0; i < sizeof(requests) / sizeof(requests[0]); i++)
		if (atomic_load(&requests[i].returned)) test_fail("old killed request resumed late");
	if (munmap(sentinel, page)) test_perror("exit sentinel cleanup");
	free(stack);
	test_pass();
}
