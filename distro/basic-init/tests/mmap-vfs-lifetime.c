/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <pthread.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

/* Private fixtures under CONFIG_WASM_MMAP_COPY_TEST, never application UAPI. */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255
#define WAIT_ENTERED 0x5770
#define PROCEED 0x5771

struct request {
	int fd;
	size_t page;
	long result;
	int error;
};

static void *reader(void *arg)
{
	struct request *request = arg;
	errno = 0;
	request->result = syscall(FILE_READ_TEST_NR, (unsigned long)request->fd,
		(unsigned long)request->page, (unsigned long)0, (unsigned long)0);
	request->error = errno;
	return NULL;
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create lifetime fixture");
	return fd;
}

static void content(const unsigned char *bytes, size_t page)
{
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("lifetime fixture content mismatch");
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected lifetime fixture page size");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("lifetime sentinel mmap");
	for (size_t i = 0; i < page; i++) sentinel[i] = (unsigned char)(i * 19 + 7);
	for (int round = 0; round < 8; round++) {
		for (unsigned int mode = 4; mode <= 5; mode++) {
			int fd = create(mode);
			int control = dup(fd);
			if (control < 0) test_perror("dup barrier control");
			if (lseek(control, 23, SEEK_SET) != 23) test_perror("set lifetime position");
			struct request request = { .fd = fd, .page = page };
			pthread_t thread;
			if (pthread_create(&thread, NULL, reader, &request)) test_fail("start lifetime reader");
			/* No sleeps: the kernel signals only after the mapping request
			 * owns its file reference and staging, and reaches read_iter. */
			if (ioctl(control, WAIT_ENTERED, 0UL)) test_perror("wait for read barrier");
			if (close(fd)) test_perror("close in-flight source fd");
			/* Opposite outcome makes accidental re-lookup of the reused fd
			 * detectable: EINTR source for success, healthy source for EIO. */
			int replacement = create(mode == 4 ? 3 : 0);
			if (replacement != fd) test_fail("in-flight fd was not reused");
			if (ioctl(control, PROCEED, 0UL)) test_perror("release read barrier");
			if (pthread_join(thread, NULL)) test_fail("join lifetime reader");
			if (lseek(control, 0, SEEK_CUR) != 23 || lseek(replacement, 0, SEEK_CUR) != 0)
				test_fail("in-flight read changed shared or replacement position");
			if (close(control) || close(replacement)) test_perror("close lifetime fixtures");
			if (mode == 4) {
				if (request.result == -1) test_fail("fd close cancelled pinned read");
				unsigned char *bytes = (void *)(uintptr_t)request.result;
				content(bytes, page);
				if (munmap(bytes, page)) test_perror("lifetime successful unmap");
			} else if (request.result != -1 || request.error != EIO) {
				test_fail("partial failed read published a mapping or lost EIO");
			}
			for (size_t i = 0; i < page; i++)
				if (sentinel[i] != (unsigned char)(i * 19 + 7))
					test_fail("in-flight request damaged live anonymous backing");
			/* A later independent request must succeed after either outcome. */
			struct request recovery = { .fd = create(0), .page = page };
			reader(&recovery);
			if (recovery.result == -1) test_fail("lifetime cleanup prevented recovery");
			unsigned char *bytes = (void *)(uintptr_t)recovery.result;
			content(bytes, page);
			if (munmap(bytes, page) || close(recovery.fd)) test_perror("recovery cleanup");
		}
	}
	if (munmap(sentinel, page)) test_perror("lifetime sentinel cleanup");
	test_pass();
}
