/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static pthread_t receiver;
static volatile sig_atomic_t delivered, handler_error;
static volatile sig_atomic_t handler_ack = -1;
static _Alignas(16) char child_stack[64 * 1024];

static void handler(int number)
{
	int saved_errno = errno;
	sigset_t mask;
	if (number != SIGUSR1 || sigprocmask(SIG_SETMASK, NULL, &mask) ||
	    sigismember(&mask, SIGUSR1) != 1 || sigismember(&mask, SIGUSR2) != 1 ||
	    getpid() <= 0)
		handler_error = 1;
	delivered++;
	if (handler_ack >= 0 && write(handler_ack, "H", 1) != 1)
		handler_error = 1;
	errno = saved_errno;
}

static int64_t now_ms(void)
{
	struct timespec time;
	if (clock_gettime(CLOCK_MONOTONIC, &time)) test_perror("clock_gettime");
	return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

static void set_mask(int block)
{
	sigset_t mask;
	if (sigemptyset(&mask) || sigaddset(&mask, SIGUSR1)) test_perror("signal set");
	int error = pthread_sigmask(block ? SIG_BLOCK : SIG_UNBLOCK, &mask, NULL);
	if (error) { errno = error; test_perror("pthread_sigmask"); }
}

static void join_sender(pthread_t thread)
{
	void *result;
	int error = pthread_join(thread, &result);
	if (error || result) test_fail("signal sender did not finish successfully");
}

struct full_pipe { int fd, capacity; };

static void *interrupt_full_pipe(void *opaque)
{
	const struct full_pipe *pipe = opaque;
	int64_t deadline = now_ms() + 2000;
	for (;;) {
		int bytes;
		if (ioctl(pipe->fd, FIONREAD, &bytes)) return (void *)(uintptr_t)1;
		if (bytes == pipe->capacity) break;
		if (bytes < 0 || bytes > pipe->capacity || now_ms() >= deadline)
			return (void *)(uintptr_t)2;
		sched_yield();
	}
	/* No reader drains the pipe. Fullness proves write has committed bytes,
	 * so the signal cannot accidentally precede all write progress. */
	return (void *)(uintptr_t)pthread_kill(receiver, SIGUSR1);
}

static void test_partial_io(int restart)
{
	int descriptors[2];
	if (pipe(descriptors)) test_perror("partial I/O pipe");
	int capacity = fcntl(descriptors[1], F_GETPIPE_SZ);
	if (capacity < 4096 || capacity > 1024 * 1024)
		test_fail("pipe capacity is outside the bounded fixture range");
	size_t length = (size_t)capacity * 2;
	unsigned char *input = malloc(length), *output = malloc(length);
	if (!input || !output) test_fail("partial I/O buffers");
	for (size_t i = 0; i < length; i++) input[i] = (unsigned char)(i * 29 + i / 251);
	struct sigaction action = { .sa_handler = handler, .sa_flags = restart ? SA_RESTART : 0 };
	if (sigemptyset(&action.sa_mask) || sigaction(SIGUSR1, &action, NULL))
		test_perror("partial write handler");
	delivered = handler_error = 0;
	set_mask(1);
	struct full_pipe args = { .fd = descriptors[0], .capacity = capacity };
	pthread_t thread;
	int error = pthread_create(&thread, NULL, interrupt_full_pipe, &args);
	if (error) { errno = error; test_perror("partial write sender"); }
	set_mask(0);
	ssize_t written = write(descriptors[1], input, length);
	join_sender(thread);
	if (written != capacity || delivered != 1 || handler_error)
		test_fail("interrupted write lost its committed byte count");
	/* A pipe read returns the available prefix, not the entire requested
	 * length. Its writer is still open; waiting for EOF here would deadlock. */
	ssize_t count = read(descriptors[0], output, length);
	if (count != written || memcmp(input, output, (size_t)count))
		test_fail("partial read lost or duplicated the committed prefix");
	int bytes;
	if (ioctl(descriptors[0], FIONREAD, &bytes) || bytes != 0)
		test_fail("partial write secretly retried or left duplicate bytes");
	/* Only the application retries the suffix, after making room. */
	if (write(descriptors[1], input + written, length - (size_t)written) != capacity ||
	    read(descriptors[0], output + count, length - (size_t)count) != capacity ||
	    memcmp(input, output, length))
		test_fail("explicit suffix retry did not reconstruct the original bytes");
	if (fcntl(descriptors[0], F_SETFL, O_NONBLOCK)) test_perror("nonblocking pipe");
	errno = 0;
	if (read(descriptors[0], output, 1) != -1 || errno != EAGAIN)
		test_fail("empty pipe contained extra data after suffix retry");
	if (close(descriptors[1]) || read(descriptors[0], output, 1) != 0 || close(descriptors[0]))
		test_fail("pipe EOF or cleanup failed");
	free(input);
	free(output);
}

struct wait_sender { int ack, release; atomic_int stop; };

static void *interrupt_wait(void *opaque)
{
	struct wait_sender *args = opaque;
	int64_t deadline = now_ms() + 2000;
	unsigned int acknowledged = 0;
	while (!atomic_load(&args->stop)) {
		if (now_ms() >= deadline || pthread_kill(receiver, SIGUSR1))
			return (void *)(uintptr_t)1;
		char byte;
		if (read(args->ack, &byte, 1) != 1 || byte != 'H') return (void *)(uintptr_t)2;
		if (++acknowledged == 16 && args->release >= 0) {
			/* Keep the child alive through sixteen handler acknowledgements. Only
			 * then may a restartable wait obtain a terminal child status. */
			return (void *)(uintptr_t)(write(args->release, "X", 1) != 1);
		}
		/* This only paces retries. Correctness does not assume the receiver
		 * has entered waitpid after any particular delay. */
		const struct timespec pace = { .tv_nsec = 1000000 };
		nanosleep(&pace, NULL);
	}
	return NULL;
}

static int exit_child(void *opaque)
{
	int fd = *(int *)opaque;
	char byte;
	return read(fd, &byte, 1) == 1 && byte == 'X' ? 37 : 38;
}

static void test_wait_reaping(int restart)
{
	int release[2], ack[2];
	struct sigaction action = { .sa_handler = handler };
	action.sa_flags = restart ? SA_RESTART : 0;
	if (sigemptyset(&action.sa_mask) || sigaction(SIGUSR1, &action, NULL) ||
	    pipe(release) || pipe(ack)) test_perror("wait fixture setup");
	set_mask(1);
	pid_t child = clone(exit_child, child_stack + sizeof(child_stack), SIGCHLD, &release[0]);
	if (child < 0) test_perror("clone wait child");
	/* The child cannot exit until the parent explicitly releases it. */
	struct wait_sender args = { .ack = ack[0], .release = restart ? release[1] : -1, .stop = 0 };
	handler_ack = ack[1];
	delivered = handler_error = 0;
	pthread_t thread;
	int error = pthread_create(&thread, NULL, interrupt_wait, &args);
	if (error) { errno = error; test_perror("wait signal sender"); }
	set_mask(0);
	int status = 0x1234;
	errno = 0;
	pid_t result = waitpid(child, &status, 0);
	int saved_errno = errno;
	atomic_store(&args.stop, 1);
	join_sender(thread);
	handler_ack = -1;
	sigset_t returned;
	if (sigprocmask(SIG_SETMASK, NULL, &returned) ||
	    sigismember(&returned, SIGUSR1) != 0 || sigismember(&returned, SIGUSR2) != 1)
		test_fail("child wait leaked the handler signal mask");
	if (restart) {
		if (result != child || delivered != 16 || handler_error ||
		    !WIFEXITED(status) || WEXITSTATUS(status) != 37) {
			/* Also used by the host's no-SA_RESTART negative control:
			 * release/reap a still-live child before reporting failure. */
			if (result != child) {
				if (write(release[1], "X", 1) != 1) test_perror("release failed restart child");
				while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
			}
			test_fail("SA_RESTART wait exposed EINTR or lost the child exit status");
		}
		goto reaped;
	}
	if (result != -1 || saved_errno != EINTR || !delivered || handler_error || status != 0x1234)
		test_fail("interrupted wait consumed a live child or lost EINTR");
	if (waitpid(child, &status, WNOHANG) != 0 || status != 0x1234)
		test_fail("WNOHANG did not preserve the unreaped live child");
	if (write(release[1], "X", 1) != 1) test_perror("release wait child");
	for (int i = 0; i < 2; i++) {
		siginfo_t info = {0};
		if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT)) test_perror("waitid WNOWAIT");
		if (info.si_pid != child || info.si_code != CLD_EXITED || info.si_status != 37)
			test_fail("WNOWAIT lost the child's stable exit status");
	}
	if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 37)
		test_fail("waitpid did not reap the expected child exactly once");
reaped:
	errno = 0;
	if (waitpid(child, &status, WNOHANG) != -1 || errno != ECHILD)
		test_fail("reaped child remained waitable");
	if (close(release[0]) || close(release[1]) || close(ack[0]) || close(ack[1]))
		test_perror("wait fixture cleanup");
}

int main(void)
{
	sigset_t original, mask;
	struct sigaction previous, child_previous, child_action = { .sa_handler = SIG_DFL };
	if (sigprocmask(SIG_SETMASK, NULL, &original) || sigaction(SIGUSR1, NULL, &previous) ||
	    sigemptyset(&child_action.sa_mask) || sigaction(SIGCHLD, &child_action, &child_previous))
		test_perror("initial signal state");
	mask = original;
	if (sigaddset(&mask, SIGUSR2) || sigprocmask(SIG_SETMASK, &mask, NULL))
		test_perror("block unrelated signal");
	receiver = pthread_self();
	test_partial_io(0);
	test_partial_io(1);
	test_wait_reaping(0);
	test_wait_reaping(1);
	if (sigaction(SIGUSR1, &previous, NULL) || sigaction(SIGCHLD, &child_previous, NULL) ||
	    sigprocmask(SIG_SETMASK, &original, NULL)) test_perror("restore signal state");
	puts("signal I/O: partial progress, explicit suffix retry, EINTR/restart and single child reaping verified");
	test_pass();
}
