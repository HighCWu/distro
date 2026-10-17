/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <time.h>

static void checked(int status, const char *operation)
{
	if (status) { errno = status; test_perror(operation); }
}

static int timed_lock_seconds(pthread_mutex_t *mutex, int seconds)
{
	struct timespec deadline;
	if (clock_gettime(CLOCK_REALTIME, &deadline)) test_perror("robust mutex clock");
	deadline.tv_sec += seconds;
	return pthread_mutex_timedlock(mutex, &deadline);
}

static int timed_lock(pthread_mutex_t *mutex)
{
	return timed_lock_seconds(mutex, 2);
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

#define CONTENDERS 4
struct contention {
	pthread_mutex_t mutex, gate;
	pthread_cond_t changed;
	unsigned ready, owns, recovered, value;
};

static void wait_for(struct contention *group, unsigned *value, unsigned expected)
{
	struct timespec deadline;
	if (clock_gettime(CLOCK_REALTIME, &deadline)) test_perror("contention clock");
	deadline.tv_sec += 10;
	while (*value < expected)
		checked(pthread_cond_timedwait(&group->changed, &group->gate, &deadline),
			"contention coordination wait");
}

static void *contended_owner(void *opaque)
{
	struct contention *group = opaque;
	checked(timed_lock(&group->mutex), "contention owner lock");
	checked(pthread_mutex_lock(&group->gate), "contention owner gate");
	group->owns = 1;
	checked(pthread_cond_broadcast(&group->changed), "contention owner ready");
	wait_for(group, &group->ready, CONTENDERS);
	checked(pthread_mutex_unlock(&group->gate), "contention owner ungate");
	return group; /* Deliberately leave the robust mutex locked. */
}

static void *contending_recoverer(void *opaque)
{
	struct contention *group = opaque;
	/* This proves overlap with a live owner, not that every thread has
	 * entered the kernel futex queue before that owner exits. */
	if (pthread_mutex_trylock(&group->mutex) != EBUSY)
		test_fail("contender did not observe the live owner");
	checked(pthread_mutex_lock(&group->gate), "contender gate");
	group->ready++;
	checked(pthread_cond_broadcast(&group->changed), "contender ready");
	checked(pthread_mutex_unlock(&group->gate), "contender ungate");
	int status = timed_lock_seconds(&group->mutex, 10);
	if (status == EOWNERDEAD) {
		group->recovered++;
		checked(pthread_mutex_consistent(&group->mutex), "repair contended mutex");
	} else if (status) test_fail("contending waiter did not acquire repaired mutex");
	group->value++;
	checked(pthread_mutex_unlock(&group->mutex), "contender unlock");
	return group;
}

static void contended_recovery(void)
{
	struct contention group = {0};
	pthread_t owner, contenders[CONTENDERS];
	init_mutex(&group.mutex);
	checked(pthread_mutex_init(&group.gate, NULL), "contention gate init");
	checked(pthread_cond_init(&group.changed, NULL), "contention cond init");
	checked(pthread_create(&owner, NULL, contended_owner, &group), "create contended owner");
	checked(pthread_mutex_lock(&group.gate), "main contention gate");
	wait_for(&group, &group.owns, 1);
	checked(pthread_mutex_unlock(&group.gate), "main contention ungate");
	for (unsigned i = 0; i < CONTENDERS; i++)
		checked(pthread_create(&contenders[i], NULL, contending_recoverer, &group), "create contender");
	void *result;
	checked(pthread_join(owner, &result), "join contended owner");
	if (result != &group) test_fail("contended owner result mismatch");
	for (unsigned i = 0; i < CONTENDERS; i++) {
		checked(pthread_join(contenders[i], &result), "join contender");
		if (result != &group) test_fail("contender result mismatch");
	}
	if (group.recovered != 1 || group.value != CONTENDERS)
		test_fail("contended recovery did not serialize all owners");
	checked(pthread_mutex_destroy(&group.mutex), "destroy contended mutex");
	checked(pthread_cond_destroy(&group.changed), "destroy contention cond");
	checked(pthread_mutex_destroy(&group.gate), "destroy contention gate");
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
		contended_recovery();
	}
	puts("robust mutex: four contending threads serialize one owner-dead repair verified");
	puts("robust mutex: owner death, consistent recovery, unrecoverable state and cancellation verified");
	test_pass();
}
