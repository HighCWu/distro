/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <pthread.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include "mmap-vfs-stats.h"

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

static void reserved(long expected)
{
	long actual = syscall(MMAP_STATS_TEST_NR, (unsigned long)3);
	if (actual < 0) test_perror("query copy budget");
	if (actual != expected) test_fail("copy budget mismatch at stable barrier");
}

static void budget(size_t page)
{
	/* Two maximum-size requests exhaust the global eight-page charge.
	 * Run both a successful read and partial-read rollback as the first
	 * finisher. Independent barriers make admission/refusal deterministic. */
	for (unsigned int mode = 4; mode <= 5; mode++) {
		mmap_stats_wait(0, 0, 0);
		struct request requests[2] = {
			{ .fd = create(mode), .page = 2 * page },
			{ .fd = create(4), .page = 2 * page },
		};
		pthread_t threads[2];
		for (int i = 0; i < 2; i++) {
			if (pthread_create(&threads[i], NULL, reader, &requests[i]))
				test_fail("start budget reader");
			if (ioctl(requests[i].fd, WAIT_ENTERED, 0UL))
				test_perror("wait budget read barrier");
		}
		mmap_stats_expect(2, 2, 2);
		reserved(8 * page);
		struct request retry = { .fd = create(0), .page = 1 };
		reader(&retry);
		if (retry.result != -1 || retry.error != ENOMEM)
			test_fail("exhausted budget admitted even a one-byte copy");
		mmap_stats_expect(2, 2, 3);
		reserved(8 * page);
		for (int i = 0; i < 2; i++) {
			if (ioctl(requests[i].fd, PROCEED, 0UL))
				test_perror("release budget reader");
			if (pthread_join(threads[i], NULL)) test_fail("join budget reader");
			if (i == 0 && mode == 5) {
				if (requests[i].result != -1 || requests[i].error != EIO)
					test_fail("budget rollback lost partial read error");
			} else {
				if (requests[i].result == -1) test_fail("budget reader failed");
				unsigned char *bytes = (void *)(uintptr_t)requests[i].result;
				content(bytes, 2 * page);
				if (munmap(bytes, 2 * page)) test_perror("budget mapping cleanup");
			}
			reserved(i == 0 ? 4 * page : 0);
			/* Reuse the previously rejected fd while the second request
			 * still owns its reservation; no global reset is permitted. */
			retry.page = 2 * page;
			reader(&retry);
			if (retry.result == -1) test_fail("released budget was not reusable");
			unsigned char *bytes = (void *)(uintptr_t)retry.result;
			content(bytes, 2 * page);
			if (munmap(bytes, 2 * page)) test_perror("budget retry cleanup");
			reserved(i == 0 ? 4 * page : 0);
		}
		if (close(requests[0].fd) || close(requests[1].fd) || close(retry.fd))
			test_perror("close budget fixtures");
		mmap_stats_wait(0, 0, 0);
	}
	puts("file mmap: concurrent copy budget and rollback verified");
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected lifetime fixture page size");
	mmap_stats_start();
	budget(page);
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
			unsigned char *temporary = mmap(0, page, PROT_READ | PROT_WRITE,
				MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
			if (temporary == MAP_FAILED) test_perror("anonymous allocation during read");
			temporary[0] = 0x5a;
			temporary[page - 1] = 0xa5;
			if (munmap(temporary, page)) test_perror("anonymous unmap during read");
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
	mmap_stats_wait(0, 0, 0);
	test_pass();
}
