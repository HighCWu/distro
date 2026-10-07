/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

/* Private test-kernel fixtures only, not application UAPI. */
#define FILE_CREATE_TEST_NR 254
#define FILE_READ_TEST_NR 255
#define WAIT_ENTERED 0x5770
#define PROCEED 0x5771

extern long __wasm_mmap_init_v1(size_t, size_t);
static _Thread_local volatile sig_atomic_t handled;
static _Thread_local volatile sig_atomic_t notification_error;
/* Set before pthread_create and kept valid until pthread_join completes. */
static int notification_fd = -1;

struct request {
	int fd;
	size_t page;
	long result;
	int error;
	sig_atomic_t signals;
	sig_atomic_t notification_failed;
};

static void handler(int signo)
{
	int saved_errno = errno;
	char byte = 'H';

	if (signo == SIGUSR1) {
		handled++;
		/* One byte into an empty pipe; write is async-signal-safe. No
		 * allocation, mapping, or busy-waiting in the handler. */
		if (write(notification_fd, &byte, 1) != 1) notification_error = 1;
	}
	errno = saved_errno;
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
	if (pthread_sigmask(SIG_UNBLOCK, &mask, NULL)) test_fail("unblock restart reader signal");
	handled = notification_error = 0;
	errno = 0;
	request->result = read_mapping(request->fd, request->page);
	request->error = errno;
	request->signals = handled;
	request->notification_failed = notification_error;
	if (__wasm_mmap_init_v1(request->page, 0) != -EPERM)
		test_fail("copy authorization survived restarted syscall return");
	return NULL;
}

static int create(unsigned int mode)
{
	int fd = (int)syscall(FILE_CREATE_TEST_NR, (unsigned long)mode);
	if (fd < 0) test_perror("create restart fixture");
	return fd;
}

static void check_bytes(const unsigned char *bytes, size_t page)
{
	for (size_t i = 0; i < page; i++)
		if (bytes[i] != (unsigned char)(i * 37 + 11))
			test_fail("restarted mapping content mismatch");
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	struct sigaction action = { .sa_handler = handler, .sa_flags = SA_RESTART };
	if (page != 65536) test_fail("unexpected restart fixture page size");
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGUSR1, &action, NULL)) test_perror("install restarting handler");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("restart sentinel mmap");
	for (size_t i = 0; i < page; i++) sentinel[i] = (unsigned char)(i * 19 + 7);
	for (int round = 0; round < 8; round++) {
		for (unsigned int mode = 4; mode <= 5; mode++) {
			int pipes[2];
			if (pipe(pipes)) test_perror("restart notification pipe");
			notification_fd = pipes[1];
			int fd = create(mode);
			if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set restart fixture position");
			struct request request = { .fd = fd, .page = page };
			pthread_t thread;
			if (pthread_create(&thread, NULL, reader, &request)) test_fail("start restart reader");
			if (ioctl(fd, WAIT_ENTERED, 0UL)) test_perror("wait for restart read barrier");
			if (pthread_kill(thread, SIGUSR1)) test_fail("signal restarting reader");
			char byte;
			/* No sleep: acknowledge handler execution before permitting I/O.
			 * The request may resume immediately after the handler returns. */
			if (read(pipes[0], &byte, 1) != 1 || byte != 'H')
				test_fail("restart handler did not acknowledge signal");
			if (ioctl(fd, PROCEED, 0UL)) test_perror("release restart read barrier");
			if (pthread_join(thread, NULL)) test_fail("join restarted reader");
			if (request.signals != 1 || request.notification_failed || handled)
				test_fail("restart signal handled by wrong thread or more than once");
			if (mode == 4) {
				if (request.result == -1) test_fail("SA_RESTART did not resume mapping");
				unsigned char *bytes = (void *)(uintptr_t)request.result;
				check_bytes(bytes, page);
				if (munmap(bytes, page)) test_perror("restarted mapping unmap");
			} else if (request.result != -1 || request.error != EIO) {
				test_fail("restarted partial failure published mapping or lost EIO");
			}
			if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("restart changed file position");
			if (close(fd) || close(pipes[0]) || close(pipes[1])) test_perror("restart fixture cleanup");
			notification_fd = -1;
			for (size_t i = 0; i < page; i++)
				if (sentinel[i] != (unsigned char)(i * 19 + 7))
					test_fail("restart damaged live anonymous mapping");
			int recovery = create(0);
			long result = read_mapping(recovery, page);
			if (result == -1) test_perror("post-restart recovery");
			unsigned char *bytes = (void *)(uintptr_t)result;
			check_bytes(bytes, page);
			if (munmap(bytes, page) || close(recovery)) test_perror("restart recovery cleanup");
		}
	}
	if (munmap(sentinel, page)) test_perror("restart sentinel cleanup");
	test_pass();
}
