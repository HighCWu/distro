/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <sys/select.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t delivered;
static volatile sig_atomic_t handler_error;
static pthread_t receiver;
static int commands[2], acknowledgements[2];

static void handler(int signal_number)
{
	int saved_errno = errno;
	sigset_t mask;
	if (signal_number != SIGUSR1 || sigprocmask(SIG_SETMASK, NULL, &mask) ||
	    sigismember(&mask, SIGUSR1) != 1 || sigismember(&mask, SIGUSR2) != 1)
		handler_error = 1;
	delivered++;
	errno = saved_errno;
}

static void *sender(void *unused)
{
	(void)unused;
	char command;
	while (read(commands[0], &command, 1) == 1) {
		if (command == 'Q') return NULL;
		int error = pthread_kill(receiver, SIGUSR1);
		if (error) return (void *)(uintptr_t)error;
		if (write(acknowledgements[1], "A", 1) != 1)
			return (void *)(uintptr_t)1;
	}
	return (void *)(uintptr_t)2;
}

static void check_mask(const sigset_t *expected)
{
	sigset_t actual;
	if (sigprocmask(SIG_SETMASK, NULL, &actual)) test_perror("query signal mask");
	for (int i = 1; i < NSIG; i++)
		if (sigismember(&actual, i) != sigismember(expected, i))
			test_fail("wait did not restore the exact original signal mask");
}

/* The libc wrappers must not modify the caller's timeout. No retry loop:
 * ppoll/pselect are interruptible even when the handler uses SA_RESTART. */
static int wait_once(int select_mode, int fd, const sigset_t *mask,
		     const struct timespec *timeout)
{
	struct timespec copy = *timeout;
	int result, saved_errno;
	if (select_mode) {
		fd_set reads;
		FD_ZERO(&reads);
		if (fd >= FD_SETSIZE) test_fail("fixture descriptor exceeds FD_SETSIZE");
		if (fd >= 0) FD_SET(fd, &reads);
		result = pselect(fd + 1, &reads, NULL, NULL, &copy, mask);
		saved_errno = errno;
		if (result == 1 && (fd < 0 || !FD_ISSET(fd, &reads)))
			test_fail("pselect lost the ready descriptor");
	} else {
		struct pollfd ready = { .fd = fd, .events = POLLIN };
		result = ppoll(fd < 0 ? NULL : &ready, fd < 0 ? 0 : 1, &copy, mask);
		saved_errno = errno;
		if (result == 1 && ready.revents != POLLIN)
			test_fail("ppoll returned unexpected readiness flags");
	}
	if (copy.tv_sec != timeout->tv_sec || copy.tv_nsec != timeout->tv_nsec)
		test_fail("wait modified the caller's timeout");
	errno = saved_errno;
	return result;
}

static void expect_interrupt(int select_mode, const sigset_t *temporary,
			     const sigset_t *blocked)
{
	const struct timespec bounded = { .tv_sec = 2 };
	errno = 0;
	int result = wait_once(select_mode, -1, temporary, &bounded);
	int error = errno;
	check_mask(blocked);
	if (result != -1 || error != EINTR)
		test_fail("temporary unmask did not interrupt wait with EINTR");
	if (delivered != 1 || handler_error)
		test_fail("signal handler count or temporary mask was incorrect");
	sigset_t pending;
	if (sigpending(&pending) || sigismember(&pending, SIGUSR1) != 0)
		test_fail("delivered signal remained pending");
}

static void test_handoff(int select_mode, int concurrent,
			 const sigset_t *temporary, const sigset_t *blocked)
{
	for (int i = 0; i < 16; i++) {
		delivered = 0;
		if (concurrent) {
			/* The sender can run before or during wait registration. There
			 * is no timing sleep, and exactly one signal is outstanding. */
			if (write(commands[1], "S", 1) != 1) test_perror("request signal");
		} else {
			int error = pthread_kill(receiver, SIGUSR1);
			if (error) { errno = error; test_perror("queue blocked signal"); }
			sigset_t pending;
			if (sigpending(&pending) || sigismember(&pending, SIGUSR1) != 1 || delivered)
				test_fail("blocked signal was not pending before wait");
		}
		expect_interrupt(select_mode, temporary, blocked);
		if (concurrent) {
			char byte;
			if (read(acknowledgements[0], &byte, 1) != 1 || byte != 'A')
				test_fail("sender did not acknowledge the signal");
		}
	}
}

static void test_blocked_timeout_and_readiness(int select_mode,
			const sigset_t *temporary, const sigset_t *blocked)
{
	const struct timespec timeout = { .tv_nsec = 40000000 };
	const struct timespec bounded = { .tv_sec = 2 };
	struct timespec before, after;
	sigset_t pending;
	int descriptors[2];
	char byte;
	delivered = 0;
	int error = pthread_kill(receiver, SIGUSR1);
	if (error) { errno = error; test_perror("queue timeout signal"); }
	if (clock_gettime(CLOCK_MONOTONIC, &before)) test_perror("timeout start");
	if (wait_once(select_mode, -1, blocked, &timeout) != 0)
		test_fail("blocked signal prevented a genuine wait timeout");
	if (clock_gettime(CLOCK_MONOTONIC, &after)) test_perror("timeout finish");
	int64_t elapsed = (int64_t)(after.tv_sec - before.tv_sec) * 1000000000 +
		(after.tv_nsec - before.tv_nsec);
	if (elapsed < 20000000) test_fail("wait timeout returned substantially early");
	check_mask(blocked);
	if (delivered || sigpending(&pending) || sigismember(&pending, SIGUSR1) != 1)
		test_fail("timeout consumed or delivered a blocked signal");
	if (pipe(descriptors) || write(descriptors[1], "R", 1) != 1)
		test_perror("prepare ready pipe");
	if (wait_once(select_mode, descriptors[0], blocked, &bounded) != 1)
		test_fail("blocked signal lost ready-fd result");
	check_mask(blocked);
	if (delivered || read(descriptors[0], &byte, 1) != 1 || byte != 'R')
		test_fail("ready wait consumed data or delivered blocked signal");
	const struct timespec zero = { 0 };
	if (wait_once(select_mode, descriptors[0], blocked, &zero) != 0)
		test_fail("consumed pipe data remained readable");
	if (close(descriptors[0]) || close(descriptors[1])) test_perror("close ready pipe");
	expect_interrupt(select_mode, temporary, blocked);
}

int main(void)
{
	sigset_t original, blocked, temporary;
	struct sigaction previous;
	struct sigaction action = { .sa_handler = handler };
	if (sigemptyset(&action.sa_mask) || sigprocmask(SIG_SETMASK, NULL, &original))
		test_perror("initial signal state");
	blocked = original;
	if (sigaddset(&blocked, SIGUSR1) || sigaddset(&blocked, SIGUSR2) ||
	    sigprocmask(SIG_SETMASK, &blocked, NULL)) test_perror("block fixture signals");
	temporary = blocked;
	if (sigdelset(&temporary, SIGUSR1)) test_perror("temporary unmask");
	if (sigaction(SIGUSR1, &action, &previous) || pipe(commands) || pipe(acknowledgements))
		test_perror("signal fixture setup");
	receiver = pthread_self();
	pthread_t thread;
	int error = pthread_create(&thread, NULL, sender, NULL);
	if (error) { errno = error; test_perror("create signal sender"); }
	for (int restart = 0; restart < 2; restart++) {
		action.sa_flags = restart ? SA_RESTART : 0;
		if (sigaction(SIGUSR1, &action, NULL)) test_perror("set restart policy");
		for (int select_mode = 0; select_mode < 2; select_mode++) {
			test_handoff(select_mode, 0, &temporary, &blocked);
			test_handoff(select_mode, 1, &temporary, &blocked);
			test_blocked_timeout_and_readiness(select_mode, &temporary, &blocked);
		}
	}
	if (write(commands[1], "Q", 1) != 1) test_perror("stop signal sender");
	void *result;
	error = pthread_join(thread, &result);
	if (error || result) test_fail("signal sender did not finish successfully");
	if (close(commands[0]) || close(commands[1]) || close(acknowledgements[0]) ||
	    close(acknowledgements[1])) test_perror("close signal fixture pipes");
	if (sigaction(SIGUSR1, &previous, NULL) || sigprocmask(SIG_SETMASK, &original, NULL))
		test_perror("restore signal state");
	puts("signal waits: pending/concurrent mask handoff, EINTR, timeout and readiness verified");
	test_pass();
}
