/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

/* Private fixture slots; clone is the existing callback API, not fork(). */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255
#define WAIT_ENTERED 0x5770
#define PROCEED 0x5771

extern long __wasm_mmap_init_v1(size_t, size_t);

struct mapping {
	unsigned char *bytes;
	size_t page;
};

struct request {
	int fd;
	size_t page;
	long result;
};

static int content(const unsigned char *bytes, size_t page)
{
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11)) return 0;
	return 1;
}

static long read_mapping(int fd, size_t page)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)page,
		(unsigned long)0, (unsigned long)0);
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create clone fixture");
	return fd;
}

static int private_child(void *opaque)
{
	struct mapping *mapping = opaque;
	if (!content(mapping->bytes, mapping->page)) return 1;
	if (__wasm_mmap_init_v1(mapping->page, 0) != -EPERM) return 2;
	mapping->bytes[0] ^= 0xff;
	mapping->bytes[mapping->page - 1] ^= 0xff;
	if (munmap(mapping->bytes, mapping->page)) return 3;
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)0);
	if (fd < 0) return 4;
	long result = read_mapping(fd, mapping->page);
	if (result == -1 || close(fd)) return 5;
	unsigned char *fresh = (void *)(uintptr_t)result;
	if (!content(fresh, mapping->page)) return 6;
	fresh[0] = 0xa5;
	if (munmap(fresh, mapping->page)) return 7;
	return 0;
}

static int forbidden_child(void *unused)
{
	(void)unused;
	return 93;
}

static void *reader(void *opaque)
{
	struct request *request = opaque;
	request->result = read_mapping(request->fd, request->page);
	return NULL;
}

int main(void)
{
	const size_t stack_size = 64 * 1024;
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	char *stack = malloc(stack_size);
	if (!stack) test_perror("allocate clone stack");
	if (page != 65536) test_fail("unexpected clone fixture page size");
	/* Run private snapshots before starting any pthreads. This does not
	 * assume pthread_join has already completed all kernel mm teardown. */
	for (int round = 0; round < 8; round++) {
		int fd = create(0);
		long result = read_mapping(fd, page);
		if (result == -1) test_perror("publish pre-clone copy");
		if (close(fd)) test_perror("close pre-clone source");
		struct mapping mapping = { .bytes = (void *)(uintptr_t)result, .page = page };
		if (!content(mapping.bytes, page)) test_fail("pre-clone content mismatch");
		pid_t pid = clone(private_child, stack + stack_size, SIGCHLD, &mapping);
		if (pid == -1) test_perror("clone initialized private copy");
		int status;
		if (waitpid(pid, &status, 0) != pid) test_perror("wait private clone");
		if (!WIFEXITED(status) || WEXITSTATUS(status)) test_fail("private-copy child failed");
		if (!content(mapping.bytes, page)) test_fail("child damaged parent initialized copy");
		if (__wasm_mmap_init_v1(page, 0) != -EPERM) test_fail("parent inherited copy authorization");
		mapping.bytes[0] = 0x5a;
		if (munmap(mapping.bytes, page)) test_perror("parent initialized unmap after clone");
	}
	for (int round = 0; round < 8; round++) {
		int fd = create(4);
		struct request request = { .fd = fd, .page = page };
		pthread_t thread;
		if (pthread_create(&thread, NULL, reader, &request)) test_fail("start clone barrier reader");
		if (ioctl(fd, WAIT_ENTERED, 0UL)) test_perror("wait clone read barrier");
		errno = 0;
		pid_t pid = clone(forbidden_child, stack + stack_size, SIGCHLD, NULL);
		if (pid != -1) {
			int status;
			if (waitpid(pid, &status, 0) != pid) test_perror("reap unexpected clone");
			test_fail("private clone admitted during shared-mm read");
		}
		if (errno != EOPNOTSUPP) test_perror("in-flight private clone refusal");
		if (ioctl(fd, PROCEED, 0UL)) test_perror("release clone read barrier");
		if (pthread_join(thread, NULL)) test_fail("join clone barrier reader");
		if (request.result == -1) test_fail("rejected clone disturbed in-flight read");
		unsigned char *bytes = (void *)(uintptr_t)request.result;
		if (!content(bytes, page)) test_fail("in-flight clone refusal damaged copy");
		if (munmap(bytes, page) || close(fd)) test_perror("in-flight clone fixture cleanup");
	}
	free(stack);
	test_pass();
}
