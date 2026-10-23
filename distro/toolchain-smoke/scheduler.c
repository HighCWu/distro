/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: scheduler: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
#define require(ok, what) do { if (!(ok)) fail(what); } while (0)

int main(void)
{
	struct sched_param original = {0}, observed = {0}, zero = {0};
	int policy = sched_getscheduler(0);

	require((policy == SCHED_OTHER || policy == SCHED_BATCH) &&
	        sched_getparam(0, &original) == 0 && original.sched_priority == 0,
	        "existing libc queries reach the kernel");
	require(syscall(SYS_sched_getscheduler, 0L, 0L, 0L, 0L, 0L, 0L) == policy &&
	        syscall(SYS_sched_getparam, (long)getpid(), (long)&observed, 0L, 0L, 0L, 0L) == 0 &&
	        observed.sched_priority == original.sched_priority,
	        "raw and libc query agreement");
	puts("scheduler: existing libc queries and raw syscall agreement pass");

	require(sched_setscheduler(0, SCHED_BATCH, &zero) == 0 &&
	        sched_getscheduler(getpid()) == SCHED_BATCH &&
	        syscall(SYS_sched_getscheduler, 0L, 0L, 0L, 0L, 0L, 0L) == SCHED_BATCH &&
	        sched_setparam(0, &zero) == 0 && sched_getparam(0, &observed) == 0 &&
	        observed.sched_priority == 0, "batch policy and parameter change is real");
	struct sched_param invalid = {.sched_priority = 1};

	errno = 0;
	require(sched_setparam(0, &invalid) == -1 && errno == EINVAL,
	        "non-realtime priority rejected");
	errno = 0;
	require(sched_setscheduler(0, -1, &zero) == -1 && errno == EINVAL,
	        "invalid policy rejected");
	errno = 0;
	require(sched_getscheduler(-1) == -1 && errno == EINVAL, "negative pid rejected");
	errno = 0;
	require(sched_getparam(INT_MAX, &observed) == -1 && errno == ESRCH,
	        "missing task error preserved");
	errno = 0;
	require(syscall(SYS_sched_getparam, 0L, -1L, 0L, 0L, 0L, 0L) == -1 && errno == EFAULT,
	        "kernel rejects inaccessible output");
	require(sched_getscheduler(0) == SCHED_BATCH && sched_getparam(0, &observed) == 0 &&
	        observed.sched_priority == 0, "failed changes preserve current state");
	puts("scheduler: batch changes, kernel errors and unchanged state after refusal pass");

	require(sched_setscheduler(0, policy, &original) == 0 &&
	        sched_getscheduler(0) == policy && sched_getparam(0, &observed) == 0 &&
	        observed.sched_priority == original.sched_priority &&
	        sched_yield() == 0 && getpid() > 0, "restore policy and later syscall recovery");
	puts("scheduler: original policy restoration and later syscall recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
