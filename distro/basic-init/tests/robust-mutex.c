/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <time.h>

static void checked(int status, const char *operation)
{
	if (status) { errno = status; test_perror(operation); }
}

static int timed_lock(pthread_mutex_t *mutex)
{
	struct timespec deadline;
	if (clock_gettime(CLOCK_REALTIME, &deadline)) test_perror("robust mutex clock");
	deadline.tv_sec += 2;
	return pthread_mutex_timedlock(mutex, &deadline);
}

struct owner {
	pthread_mutex_t *mutex;
	int expected;
	int cancel;
};

static void *leave_locked(void *opaque)
{
	struct owner *owner = opaque;
	if (timed_lock(owner->mutex) != owner->expected)
		test_fail("owner did not acquire the expected robust state");
	if (owner->cancel) {
		checked(pthread_setcanceltype(PTHREAD_CANCEL_DEFERRED, NULL), "deferred robust cancellation");
		checked(pthread_cancel(pthread_self()), "cancel robust owner");
		pthread_testcancel();
		test_fail("robust owner cancellation returned");
	}
	/* No unlock or cleanup handler: thread exit must leave owner-dead state. */
	return owner;
}

static void exit_owner(pthread_mutex_t *mutex, int expected, int cancel)
{
	struct owner owner = { mutex, expected, cancel };
	pthread_t thread;
	checked(pthread_create(&thread, NULL, leave_locked, &owner), "create robust owner");
	void *result;
	checked(pthread_join(thread, &result), "join robust owner");
	if (result != (cancel ? PTHREAD_CANCELED : &owner))
		test_fail("robust owner exit result mismatch");
}

static void *reuse_mutex(void *opaque)
{
	pthread_mutex_t *mutex = opaque;
	if (timed_lock(mutex)) test_fail("repaired mutex was not reusable");
	checked(pthread_mutex_unlock(mutex), "reuse robust unlock");
	return mutex;
}

static void repair_and_reuse(pthread_mutex_t *mutex)
{
	if (timed_lock(mutex) != EOWNERDEAD)
		test_fail("dead owner did not produce EOWNERDEAD");
	checked(pthread_mutex_consistent(mutex), "make mutex consistent");
	checked(pthread_mutex_unlock(mutex), "unlock repaired mutex");
	pthread_t thread;
	checked(pthread_create(&thread, NULL, reuse_mutex, mutex), "create robust reuser");
	void *result;
	checked(pthread_join(thread, &result), "join robust reuser");
	if (result != mutex) test_fail("robust reuser exit result mismatch");
}

static void init_mutex(pthread_mutex_t *mutex)
{
	pthread_mutexattr_t attributes;
	checked(pthread_mutexattr_init(&attributes), "robust attributes init");
	checked(pthread_mutexattr_setrobust(&attributes, PTHREAD_MUTEX_ROBUST), "enable robust mutex");
	checked(pthread_mutexattr_settype(&attributes, PTHREAD_MUTEX_ERRORCHECK), "robust errorcheck type");
	checked(pthread_mutex_init(mutex, &attributes), "robust mutex init");
	checked(pthread_mutexattr_destroy(&attributes), "robust attributes destroy");
}

int main(void)
{
	for (int round = 0; round < 4; round++) {
		pthread_mutex_t mutex;
		init_mutex(&mutex);
		exit_owner(&mutex, 0, 0);
		repair_and_reuse(&mutex);
		checked(pthread_mutex_destroy(&mutex), "destroy repaired mutex");

		init_mutex(&mutex);
		exit_owner(&mutex, 0, 0);
		if (timed_lock(&mutex) != EOWNERDEAD)
			test_fail("unrepaired owner did not produce EOWNERDEAD");
		/* Unlocking without consistent deliberately poisons this instance. */
		checked(pthread_mutex_unlock(&mutex), "unlock inconsistent mutex");
		if (timed_lock(&mutex) != ENOTRECOVERABLE ||
		    pthread_mutex_trylock(&mutex) != ENOTRECOVERABLE)
			test_fail("unrepaired mutex did not remain ENOTRECOVERABLE");
		checked(pthread_mutex_destroy(&mutex), "destroy unrecoverable mutex");

		init_mutex(&mutex);
		exit_owner(&mutex, 0, 0);
		/* A recovery owner may itself exit before making state consistent. */
		exit_owner(&mutex, EOWNERDEAD, 0);
		repair_and_reuse(&mutex);
		checked(pthread_mutex_destroy(&mutex), "destroy repeated-death mutex");

		init_mutex(&mutex);
		exit_owner(&mutex, 0, 1);
		repair_and_reuse(&mutex);
		checked(pthread_mutex_destroy(&mutex), "destroy cancelled-owner mutex");
	}
	puts("robust mutex: owner death, consistent recovery, unrecoverable state and cancellation verified");
	test_pass();
}
