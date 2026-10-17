/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <linux/futex.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* musl has 64-bit time_t on wasm32 too; syscall 98 still accepts time32
 * there. Use the time64 entry instead of reinterpreting struct timespec. */
#if __SIZEOF_LONG__ == 4 && defined(SYS_futex_time64)
#define FUTEX_WAIT_SYSCALL SYS_futex_time64
#else
#define FUTEX_WAIT_SYSCALL SYS_futex
#endif

static pthread_t receiver;
static volatile sig_atomic_t delivered, handler_error, ack_fd = -1;
static _Atomic uint32_t word;
_Static_assert(sizeof(word) == 4, "Linux futex words are 32-bit");

static long futex_call(long number, long operation, long value, const struct timespec *timeout)
{
	/* syscall() consumes six machine-word varargs. Unlike native register
	 * ABIs, wasm64 does not implicitly widen packed int varargs to long. */
	return syscall(number, (long)(uintptr_t)&word, operation, value,
		(long)(uintptr_t)timeout, 0L, 0L);
}

static int64_t now_ms(void)
{
	struct timespec now;
	if (clock_gettime(CLOCK_MONOTONIC, &now)) test_perror("futex clock");
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void handler(int number)
{
	int saved_errno = errno;
	sigset_t mask;
	if (number != SIGUSR1 || sigprocmask(SIG_SETMASK, NULL, &mask) ||
	    sigismember(&mask, SIGUSR1) != 1 || sigismember(&mask, SIGUSR2) != 1 ||
	    getpid() <= 0) handler_error = 1;
	delivered++;
	if (write(ack_fd, "H", 1) != 1) handler_error = 1;
	errno = saved_errno;
}

struct sender { int ack, wake; atomic_int stop; };

static void *send_signals(void *opaque)
{
	struct sender *args = opaque;
	int64_t deadline = now_ms() + 2000;
	unsigned int count = 0;
	while (!atomic_load(&args->stop)) {
		if (now_ms() >= deadline) return (void *)(uintptr_t)1;
		if (args->wake && count == 16) {
			/* Do not change the word: EAGAIN must not masquerade as a
			 * successfully restarted wait. A return of 1 proves a waiter
			 * was actually queued when this wake took place. */
			long woken = futex_call(SYS_futex, FUTEX_WAKE_PRIVATE, 1, NULL);
			if (woken == 1) return NULL;
			if (woken != 0) return (void *)(uintptr_t)2;
			sched_yield();
			continue;
		}
		if (pthread_kill(receiver, SIGUSR1)) return (void *)(uintptr_t)3;
		char byte;
		if (read(args->ack, &byte, 1) != 1 || byte != 'H') return (void *)(uintptr_t)4;
		count++;
		/* Pacing only, never proof of syscall registration. One outstanding
		 * signal at a time prevents coalescing from hiding lost handoffs. */
		const struct timespec pace = { .tv_nsec = 1000000 };
		nanosleep(&pace, NULL);
	}
	return (void *)(uintptr_t)args->wake;
}

static void interrupt_wait(int restart, int timed)
{
	int ack[2];
	sigset_t blocked, returned;
	struct sigaction action = { .sa_handler = handler, .sa_flags = restart ? SA_RESTART : 0 };
	if (sigemptyset(&blocked) || sigaddset(&blocked, SIGUSR1) ||
	    sigemptyset(&action.sa_mask) || sigaction(SIGUSR1, &action, NULL) ||
	    sigprocmask(SIG_BLOCK, &blocked, NULL) || pipe(ack)) test_perror("futex signal setup");
	struct sender args = { .ack = ack[0], .wake = restart && !timed, .stop = 0 };
	ack_fd = ack[1];
	delivered = handler_error = 0;
	atomic_store(&word, 0);
	pthread_t thread;
	int error = pthread_create(&thread, NULL, send_signals, &args);
	if (error) { errno = error; test_perror("futex signal sender"); }
	if (sigprocmask(SIG_UNBLOCK, &blocked, NULL)) test_perror("unblock futex signal");
	struct timespec timeout = { .tv_sec = 1 };
	printf("signal futex: handler restart=%d timed=%d\n", restart, timed);
	errno = 0;
	long result = futex_call(FUTEX_WAIT_SYSCALL, FUTEX_WAIT_PRIVATE, 0, timed ? &timeout : NULL);
	int saved_errno = errno;
	atomic_store(&args.stop, 1);
	void *sender_result;
	if (pthread_join(thread, &sender_result) || sender_result)
		test_fail("futex sender did not complete its signal/wake protocol");
	if (handler_error || !delivered || atomic_load(&word) != 0) {
		printf("futex result=%ld errno=%d delivered=%d handler_error=%d word=%u\n",
			result, saved_errno, (int)delivered, (int)handler_error, (unsigned)atomic_load(&word));
		test_fail("futex signal handler or unchanged word check failed");
	}
	if (sigprocmask(SIG_SETMASK, NULL, &returned) ||
	    sigismember(&returned, SIGUSR1) != 0 || sigismember(&returned, SIGUSR2) != 1)
		test_fail("futex wait leaked handler signal mask");
	if (restart && !timed) {
		if (result != 0 || delivered != 16)
			test_fail("untimed SA_RESTART futex did not resume until explicit wake");
	} else if (result != -1 || saved_errno != EINTR) {
		/* A timed FUTEX_WAIT uses ERESTART_RESTARTBLOCK: a userspace
		 * handler produces EINTR even when its action has SA_RESTART. */
		test_fail("interruptible futex did not return EINTR");
	}
	if (timeout.tv_sec != 1 || timeout.tv_nsec != 0)
		test_fail("futex modified the caller timeout");
	if (futex_call(SYS_futex, FUTEX_WAKE_PRIVATE, 1, NULL) != 0)
		test_fail("finished futex wait left a stale queue entry");
	if (close(ack[0]) || close(ack[1])) test_perror("close futex acknowledgement");
	ack_fd = -1;
}

int main(void)
{
	sigset_t original, mask;
	struct sigaction previous;
	if (sigprocmask(SIG_SETMASK, NULL, &original) || sigaction(SIGUSR1, NULL, &previous))
		test_perror("initial futex signal state");
	mask = original;
	if (sigaddset(&mask, SIGUSR2) || sigprocmask(SIG_SETMASK, &mask, NULL))
		test_perror("block unrelated futex signal");
	receiver = pthread_self();
	for (int restart = 0; restart < 2; restart++)
		for (int timed = 0; timed < 2; timed++) interrupt_wait(restart, timed);
	/* No signals now: an actual relative timeout must expire, whereas a
	 * value mismatch must fail immediately without joining a wait queue. */
	const struct timespec timeout = { .tv_nsec = 20000000 };
	int64_t started = now_ms();
	errno = 0;
	if (futex_call(FUTEX_WAIT_SYSCALL, FUTEX_WAIT_PRIVATE, 0, &timeout) != -1 ||
	    errno != ETIMEDOUT || now_ms() - started < 15)
		test_fail("uninterrupted futex timeout returned early or lost ETIMEDOUT");
	errno = 0;
	if (futex_call(FUTEX_WAIT_SYSCALL, FUTEX_WAIT_PRIVATE, 1, &timeout) != -1 || errno != EAGAIN)
		test_fail("futex mismatch did not return EAGAIN");
	if (sigaction(SIGUSR1, &previous, NULL) || sigprocmask(SIG_SETMASK, &original, NULL))
		test_perror("restore futex signal state");
	puts("signal futex: untimed restart, timed EINTR, explicit wake and queue cleanup verified");
	test_pass();
}
