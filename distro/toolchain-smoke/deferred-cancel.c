// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static int data[2], ready[2], mode;
static atomic_int cleaned, returned, tid;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;

static _Noreturn void fail(const char *message)
{
	dprintf(2, "deferred-cancel: %s errno=%d\n", message, errno);
	_exit(1);
}
static void require(int condition, const char *message) { if (!condition) fail(message); }
static void cleanup(void *unused) {
	(void)unused;
	if (mode == 3) {
		require(pthread_mutex_trylock(&mutex) == EBUSY, "cond cancellation reacquires mutex before cleanup");
		require(!pthread_mutex_unlock(&mutex), "cond cleanup unlock");
	}
	atomic_fetch_add(&cleaned, 1);
}
static void *reader(void *unused)
{
	(void)unused;
	const int scenario = mode;
	if (scenario == 2) require(!pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, NULL), "disable cancellation");
	atomic_store(&tid, (int)syscall(SYS_gettid, 0L, 0L, 0L, 0L, 0L, 0L));
	pthread_cleanup_push(cleanup, NULL);
	if (scenario == 3) require(!pthread_mutex_lock(&mutex), "cond mutex lock");
	char byte = 'r';
	require(syscall(SYS_write, (long)ready[1], (long)(uintptr_t)&byte, 1L, 0L, 0L, 0L) == 1, "reader ready");
	if (scenario == 3) {
		(void)pthread_cond_wait(&condition, &mutex);
		fail("canceled cond wait unexpectedly returned");
	}
	long count = scenario == 1 ? syscall(SYS_read, (long)data[0], (long)(uintptr_t)&byte, 1L, 0L, 0L, 0L) :
		read(data[0], &byte, 1);
	require(count == 1 && byte == 'x', "raw/disabled read returns data, not cancellation EINTR");
	atomic_store(&returned, 1);
	if (scenario == 2) require(!pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL), "restore cancellation");
	pthread_testcancel();
	pthread_cleanup_pop(1);
	return NULL;
}
static struct timespec deadline(void)
{
	struct timespec result;
	require(!clock_gettime(CLOCK_REALTIME, &result), "deadline clock");
	result.tv_sec += 5;
	return result;
}
static void blocked_reader(void)
{
	char path[96];
	snprintf(path, sizeof path, "/proc/self/task/%d/syscall", atomic_load(&tid));
	struct timespec limit = deadline(), now;
	for (;;) {
		FILE *file = fopen(path, "r");
		require(file != NULL, "observe blocked reader syscall");
		long nr = -1;
		unsigned long fd = ~0UL;
		int fields = fscanf(file, "%ld %lx", &nr, &fd);
		require(!fclose(file), "close syscall observation");
		if (fields == 2 && ((mode != 3 && nr == SYS_read && fd == (unsigned)data[0]) ||
			(mode == 3 && nr == SYS_futex))) return;
		require(!clock_gettime(CLOCK_REALTIME, &now) &&
			(now.tv_sec < limit.tv_sec || (now.tv_sec == limit.tv_sec && now.tv_nsec < limit.tv_nsec)),
			"reader reached actual blocking syscall");
		sched_yield();
	}
}
int main(void)
{
#ifdef __wasm__
	require(!mkdir("/proc", 0555) || errno == EEXIST, "proc directory");
	require(!mount("proc", "/proc", "proc", 0, NULL), "proc mount");
#endif
	for (mode = 0; mode < 4; mode++) {
		atomic_store(&cleaned, 0); atomic_store(&returned, 0); atomic_store(&tid, 0);
		require(!pipe(data) && !pipe(ready), "create reader pipes");
		pthread_t thread;
		require(!pthread_create(&thread, NULL, reader, NULL), "create reader");
		char byte;
		require(read(ready[0], &byte, 1) == 1 && byte == 'r', "reader startup");
		blocked_reader();
		require(!pthread_cancel(thread), "cancel blocked reader");
		/* The cancellation point gets no data or EOF to rescue a restarted read.
		 * Raw and disabled calls must instead finish their real I/O first. */
		if (mode == 1 || mode == 2) require(write(data[1], "x", 1) == 1, "release non-cancellation read");
		void *result = NULL;
		struct timespec limit = deadline();
		require(!pthread_timedjoin_np(thread, &result, &limit), "bounded canceled reader join");
		require(result == PTHREAD_CANCELED && atomic_load(&cleaned) == 1, "canceled result and exactly one cleanup");
		require(atomic_load(&returned) == (mode == 1 || mode == 2), "only raw/disabled read returns normally");
		if (mode == 3) require(!pthread_mutex_trylock(&mutex) && !pthread_mutex_unlock(&mutex), "cond mutex remains usable");
		require(!close(data[0]) && !close(data[1]) && !close(ready[0]) && !close(ready[1]), "pipe cleanup");
	}
	puts("deferred-cancel: actual blocked libc read cancels without data or EOF, cleanup and join pass");
	puts("deferred-cancel: raw and disabled reads finish I/O before explicit cancellation pass");
	puts("deferred-cancel: masked cond wait reacquires mutex before cleanup and leaves it usable pass");
#ifdef __wasm__
	require(!umount("/proc"), "proc cleanup");
#endif
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
