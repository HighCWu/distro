/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <time.h>

struct fixture {
	pthread_mutex_t mutex;
	pthread_cond_t cond;
	pthread_cond_t handshake;
	clockid_t clock;
	int ready;
	int cleanup_count;
};

static void checked(int status, const char *operation)
{
	if (status) { errno = status; test_perror(operation); }
}

static void *wake_waiter(void *argument)
{
	struct fixture *fixture = argument;
	checked(pthread_mutex_lock(&fixture->mutex), "worker mutex lock");
	fixture->ready = 1;
	checked(pthread_cond_signal(&fixture->cond), "worker condition signal");
	checked(pthread_mutex_unlock(&fixture->mutex), "worker mutex unlock");
	return argument;
}

static void owns_mutex(struct fixture *fixture)
{
	/* An ERRORCHECK mutex rejects unlock by a non-owner with EPERM. */
	checked(pthread_mutex_unlock(&fixture->mutex), "wait returned without mutex ownership");
	checked(pthread_mutex_lock(&fixture->mutex), "relock after ownership check");
}

static void cancellation_cleanup(void *argument)
{
	struct fixture *fixture = argument;
	fixture->cleanup_count++;
	checked(pthread_mutex_unlock(&fixture->mutex), "cancel cleanup did not own mutex");
}

static void *cancel_waiter(void *argument)
{
	struct fixture *fixture = argument;
	checked(pthread_setcanceltype(PTHREAD_CANCEL_DEFERRED, NULL), "deferred cancellation");
	checked(pthread_mutex_lock(&fixture->mutex), "cancel worker mutex lock");
	struct timespec future;
	if (clock_gettime(fixture->clock, &future)) test_perror("cancel condition deadline");
	if (future.tv_sec > 6000000000LL) test_fail("clock too large for cancel fixture");
	future.tv_sec += 3000000000LL;
	pthread_cleanup_push(cancellation_cleanup, fixture);
	fixture->ready = 1;
	checked(pthread_cond_signal(&fixture->handshake), "cancel worker handshake");
	/* There is no producer for cond in this phase. Spurious wakes are legal;
	 * the only expected way out is deferred cancellation and cleanup. */
	for (;;)
		checked(pthread_cond_timedwait(&fixture->cond, &fixture->mutex, &future),
			"cancel worker long timedwait");
	pthread_cleanup_pop(1);
	return NULL;
}

static void test_cancellation(struct fixture *fixture)
{
	for (int round = 0; round < 8; round++) {
		checked(pthread_mutex_lock(&fixture->mutex), "cancel main mutex lock");
		fixture->ready = 0;
		fixture->cleanup_count = 0;
		pthread_t worker;
		checked(pthread_create(&worker, NULL, cancel_waiter, fixture), "create cancel worker");
		while (!fixture->ready)
			checked(pthread_cond_wait(&fixture->handshake, &fixture->mutex),
				"wait cancel handshake");
		/* Owning this mutex after ready proves the worker has released it in
		 * timedwait. It does not prove enrollment in the kernel futex queue. */
		checked(pthread_cancel(worker), "cancel timed waiter");
		checked(pthread_mutex_unlock(&fixture->mutex), "release mutex for cancel cleanup");
		void *result = NULL;
		checked(pthread_join(worker, &result), "join cancelled waiter");
		if (result != PTHREAD_CANCELED) test_fail("timed waiter was not cancelled");
		checked(pthread_mutex_lock(&fixture->mutex), "reuse mutex after cancellation");
		if (fixture->cleanup_count != 1) test_fail("cancel cleanup did not execute exactly once");
		checked(pthread_cond_signal(&fixture->cond), "reuse condition after cancellation");
		checked(pthread_mutex_unlock(&fixture->mutex), "unlock reused cancel mutex");
	}
}

static void test_clock(clockid_t clock)
{
	struct fixture fixture = { .clock = clock, .ready = 0 };
	pthread_mutexattr_t mutexattr;
	pthread_condattr_t condattr;
	checked(pthread_mutexattr_init(&mutexattr), "mutexattr init");
	checked(pthread_mutexattr_settype(&mutexattr, PTHREAD_MUTEX_ERRORCHECK), "mutexattr type");
	checked(pthread_mutex_init(&fixture.mutex, &mutexattr), "mutex init");
	checked(pthread_mutexattr_destroy(&mutexattr), "mutexattr destroy");
	checked(pthread_condattr_init(&condattr), "condattr init");
	checked(pthread_condattr_setclock(&condattr, clock), "condattr clock");
	checked(pthread_cond_init(&fixture.cond, &condattr), "condition init");
	checked(pthread_cond_init(&fixture.handshake, &condattr), "handshake condition init");
	checked(pthread_condattr_destroy(&condattr), "condattr destroy");
	for (int round = 0; round < 8; round++) {
		checked(pthread_mutex_lock(&fixture.mutex), "main mutex lock");
		fixture.ready = 0;
		struct timespec future;
		if (clock_gettime(clock, &future)) test_perror("long condition deadline");
		if (future.tv_sec > 6000000000LL) test_fail("clock too large for condition fixture");
		future.tv_sec += 3000000000LL;
		struct timespec original = future;
		pthread_t worker;
		/* The worker cannot set ready until timedwait releases this mutex.
		 * This removes sleep-based ordering; spurious wakes remain permitted. */
		checked(pthread_create(&worker, NULL, wake_waiter, &fixture), "create condition worker");
		while (!fixture.ready)
			checked(pthread_cond_timedwait(&fixture.cond, &fixture.mutex, &future),
				"long condition timedwait");
		if (future.tv_sec != original.tv_sec || future.tv_nsec != original.tv_nsec)
			test_fail("condition wait modified caller deadline");
		owns_mutex(&fixture);
		checked(pthread_mutex_unlock(&fixture.mutex), "main mutex unlock");
		void *result = NULL;
		checked(pthread_join(worker, &result), "join condition worker");
		if (result != &fixture) test_fail("condition worker result mismatch");
	}
	test_cancellation(&fixture);
	checked(pthread_mutex_lock(&fixture.mutex), "timeout mutex lock");
	struct timespec deadline;
	if (clock_gettime(clock, &deadline)) test_perror("short condition deadline");
	deadline.tv_nsec += 1000000;
	if (deadline.tv_nsec >= 1000000000) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000; }
	int status;
	do {
		status = pthread_cond_timedwait(&fixture.cond, &fixture.mutex, &deadline);
	} while (!status);
	if (status != ETIMEDOUT) { errno = status; test_perror("short condition timeout"); }
	owns_mutex(&fixture);
	const struct timespec past = { .tv_nsec = 1 };
	if (pthread_cond_timedwait(&fixture.cond, &fixture.mutex, &past) != ETIMEDOUT)
		test_fail("past condition deadline did not return ETIMEDOUT");
	owns_mutex(&fixture);
	const struct timespec invalid = { .tv_sec = 3000000000LL, .tv_nsec = 1000000000 };
	if (pthread_cond_timedwait(&fixture.cond, &fixture.mutex, &invalid) != EINVAL)
		test_fail("invalid condition nanoseconds did not return EINVAL");
	owns_mutex(&fixture);
	checked(pthread_mutex_unlock(&fixture.mutex), "final mutex unlock");
	checked(pthread_cond_destroy(&fixture.cond), "condition destroy");
	checked(pthread_cond_destroy(&fixture.handshake), "handshake condition destroy");
	checked(pthread_mutex_destroy(&fixture.mutex), "mutex destroy");
}

int main(void)
{
	_Static_assert(sizeof(time_t) == 8, "thread deadlines require 64-bit time_t");
	test_clock(CLOCK_REALTIME);
	test_clock(CLOCK_MONOTONIC);
	puts("thread time ABI: wakeups, cancellation, timeouts and mutex ownership verified");
	test_pass();
}
