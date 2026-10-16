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
	int release;
	int wake_count;
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

static void *group_waiter(void *argument)
{
	struct fixture *fixture = argument;
	checked(pthread_setcanceltype(PTHREAD_CANCEL_DEFERRED, NULL), "group deferred cancellation");
	checked(pthread_mutex_lock(&fixture->mutex), "group worker mutex lock");
	struct timespec future;
	if (clock_gettime(fixture->clock, &future)) test_perror("group condition deadline");
	if (future.tv_sec > 6000000000LL) test_fail("clock too large for group fixture");
	future.tv_sec += 3000000000LL;
	pthread_cleanup_push(cancellation_cleanup, fixture);
	fixture->ready++;
	checked(pthread_cond_signal(&fixture->handshake), "group worker handshake");
	while (!fixture->release)
		checked(pthread_cond_timedwait(&fixture->cond, &fixture->mutex, &future),
			"group long timedwait");
	pthread_cleanup_pop(0);
	fixture->wake_count++;
	checked(pthread_mutex_unlock(&fixture->mutex), "group normal waiter mutex ownership");
	return argument;
}

enum broadcast_order {
	JOIN_BEFORE_BROADCAST,
	CANCEL_THEN_BROADCAST,
	BROADCAST_THEN_CANCEL,
};

static void test_group_broadcast(struct fixture *fixture, enum broadcast_order order)
{
	int cancelled_rounds = 0;
	for (int round = 0; round < 4; round++) {
		pthread_t workers[4];
		checked(pthread_mutex_lock(&fixture->mutex), "group main mutex lock");
		fixture->ready = fixture->cleanup_count = 0;
		fixture->release = fixture->wake_count = 0;
		for (size_t i = 0; i < 4; i++)
			checked(pthread_create(&workers[i], NULL, group_waiter, fixture),
				"create group waiter");
		while (fixture->ready != 4)
			checked(pthread_cond_wait(&fixture->handshake, &fixture->mutex),
				"wait group handshake");
		void *result = NULL;
		if (order == JOIN_BEFORE_BROADCAST) {
			checked(pthread_cancel(workers[0]), "cancel group member");
			checked(pthread_mutex_unlock(&fixture->mutex), "group release for cleanup");
			checked(pthread_join(workers[0], &result), "join cancelled group member");
			if (result != PTHREAD_CANCELED) test_fail("group member was not cancelled");
			checked(pthread_mutex_lock(&fixture->mutex), "group lock after cancellation");
			if (fixture->cleanup_count != 1 || fixture->wake_count != 0)
				test_fail("group cleanup count or early waiter completion mismatch");
			fixture->release = 1;
			checked(pthread_cond_broadcast(&fixture->cond), "broadcast remaining waiters");
		} else {
			/* Both requests are issued while holding the mutex, before any
			 * waiter can return with it. Do not force cancellation to win:
			 * libc may legitimately consume the wake and finish normally. */
			fixture->release = 1;
			if (order == CANCEL_THEN_BROADCAST)
				checked(pthread_cancel(workers[0]), "cancel before broadcast");
			checked(pthread_cond_broadcast(&fixture->cond), "broadcast with pending cancellation");
			if (order == BROADCAST_THEN_CANCEL)
				checked(pthread_cancel(workers[0]), "cancel after broadcast");
		}
		checked(pthread_mutex_unlock(&fixture->mutex), "group unlock after broadcast");
		if (order != JOIN_BEFORE_BROADCAST)
			checked(pthread_join(workers[0], &result), "join overlapping cancel target");
		int cancelled = result == PTHREAD_CANCELED;
		cancelled_rounds += cancelled;
		if (!cancelled && result != fixture) test_fail("cancel target result mismatch");
		for (size_t i = 1; i < 4; i++) {
			result = NULL;
			checked(pthread_join(workers[i], &result), "join broadcast waiter");
			if (result != fixture) test_fail("broadcast waiter result mismatch");
		}
		checked(pthread_mutex_lock(&fixture->mutex), "group verify mutex lock");
		if (fixture->cleanup_count != cancelled || fixture->wake_count != 4 - cancelled)
			test_fail("broadcast did not complete all surviving waiters exactly once");
		checked(pthread_mutex_unlock(&fixture->mutex), "group verify mutex unlock");
	}
	printf("thread-time-group: clock=%d order=%d cancelled=%d normal=%d\n",
		(int)fixture->clock, (int)order, cancelled_rounds, 4 - cancelled_rounds);
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
	test_group_broadcast(&fixture, JOIN_BEFORE_BROADCAST);
	test_group_broadcast(&fixture, CANCEL_THEN_BROADCAST);
	test_group_broadcast(&fixture, BROADCAST_THEN_CANCEL);
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
	puts("thread time ABI: wakeups, cancellation, broadcast, timeouts and mutex ownership verified");
	test_pass();
}
