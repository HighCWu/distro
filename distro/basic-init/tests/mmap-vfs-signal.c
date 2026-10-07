/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include "mmap-vfs-stats.h"

/* Private fixtures only. This checks actual signal delivery, not mode 3's
 * injected EINTR. The handler deliberately does not use SA_RESTART. */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255
#define WAIT_ENTERED 0x5770
#define PROCEED 0x5771

extern long __wasm_mmap_init_v1(size_t, size_t);
static _Thread_local volatile sig_atomic_t handled;

struct request {
	int fd;
	size_t page;
	long result;
	int error;
	sig_atomic_t signals;
};

static void handler(int signo)
{
	if (signo == SIGUSR1) handled++;
}

static long read_mapping(int fd, size_t page)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)page,
		(unsigned long)0, (unsigned long)0);
}

static void *reader(void *arg)
{
	struct request *request = arg;
	sigset_t mask;
	sigemptyset(&mask);
	sigaddset(&mask, SIGUSR1);
	if (pthread_sigmask(SIG_UNBLOCK, &mask, NULL)) test_fail("unblock reader signal");
	handled = 0;
	errno = 0;
	request->result = read_mapping(request->fd, request->page);
	request->error = errno;
	request->signals = handled;
	if (__wasm_mmap_init_v1(request->page, 0) != -EPERM)
		test_fail("copy authorization survived interrupted syscall return");
	return NULL;
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create signal fixture");
	return fd;
}

static void check_mapping(int fd, size_t page)
{
	long result = read_mapping(fd, page);
	if (result == -1) test_perror("map after signal interruption");
	unsigned char *bytes = (void *)(uintptr_t)result;
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("post-signal recovery content mismatch");
	if (munmap(bytes, page)) test_perror("post-signal recovery unmap");
}

int main(void)
{
	mmap_stats_start();
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	struct sigaction action = { .sa_handler = handler, .sa_flags = 0 };
	if (page != 65536) test_fail("unexpected signal fixture page size");
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGUSR1, &action, NULL)) test_perror("install interrupting handler");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("signal sentinel mmap");
	for (size_t i = 0; i < page; i++) sentinel[i] = (unsigned char)(i * 19 + 7);
	for (int round = 0; round < 8; round++) {
		for (unsigned int mode = 4; mode <= 5; mode++) {
			int fd = create(mode);
			if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set signal fixture position");
			struct request request = { .fd = fd, .page = page };
			pthread_t thread;
			if (pthread_create(&thread, NULL, reader, &request)) test_fail("start signal reader");
			if (ioctl(fd, WAIT_ENTERED, 0UL)) test_perror("wait for signal read barrier");
			mmap_stats_expect(1, 1, 1);
			if (pthread_kill(thread, SIGUSR1)) test_fail("signal blocked reader");
			/* Do not release the completion: only signal interruption can
			 * let the blocked read return. The runner watchdog bounds hangs. */
			if (pthread_join(thread, NULL)) test_fail("join interrupted reader");
			mmap_stats_expect(0, 0, 1);
			if (request.result != -1 || request.error != EINTR || request.signals != 1)
				test_fail("real signal did not abort mapping with exactly EINTR");
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("interrupted read changed file position");
			/* Late/repeated control signals cannot revive an ended request.
			 * This is synchronous VFS waiting, not asynchronous host I/O. */
			if (ioctl(fd, PROCEED, 0UL) || ioctl(fd, PROCEED, 0UL))
				test_perror("late read barrier release");
			for (size_t i = 0; i < page; i++)
				if (sentinel[i] != (unsigned char)(i * 19 + 7))
					test_fail("interrupted mapping damaged anonymous backing");
			if (mode == 4) check_mapping(fd, page);
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("retry changed file position");
			if (close(fd)) test_perror("close interrupted fixture");
			int recovery = create(0);
			check_mapping(recovery, page);
			if (close(recovery)) test_perror("close signal recovery fixture");
			mmap_stats_wait(0, 0, 0);
		}
	}
	if (handled) test_fail("reader signal was delivered to controller thread");
	if (munmap(sentinel, page)) test_perror("signal sentinel cleanup");
	test_pass();
}
