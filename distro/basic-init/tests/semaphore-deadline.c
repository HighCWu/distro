/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <semaphore.h>
#include <time.h>
#include <unistd.h>

static void deadlines(sem_t *sem)
{
	const struct { time_t seconds; long nanoseconds; int error; } cases[] = {
		{-1, 0, ETIMEDOUT}, {-1, 999999999, ETIMEDOUT},
		{-1, -1, EINVAL}, {-1, 1000000000, EINVAL},
		{0, 1000000000, EINVAL}, {0, 0, ETIMEDOUT},
	};
	for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
		struct timespec at = { cases[i].seconds, cases[i].nanoseconds };
		errno = 0;
		if (sem_timedwait(sem, &at) != -1 || errno != cases[i].error)
			test_fail("semaphore absolute deadline error mismatch");
		int value;
		if (sem_getvalue(sem, &value) || value != 0)
			test_fail("failed deadline changed semaphore value");
	}
	struct timespec unused = { -1, 0 };
	if (sem_post(sem) || sem_timedwait(sem, &unused))
		test_fail("available token validated unused deadline");
	/* glibc validates nanoseconds before its token fast path; this extra
	 * check targets musl and the Wasm named-semaphore syscall. */
#ifndef __GLIBC__
	unused.tv_nsec = 1000000000;
	if (sem_post(sem) || sem_timedwait(sem, &unused))
		test_fail("available token validated unused nanoseconds");
#endif
	errno = 0;
	if (sem_trywait(sem) != -1 || errno != EAGAIN)
		test_fail("deadline operation duplicated a token");
}

int main(void)
{
	sem_t local;
	char name[96];
	if (sem_init(&local, 0, 0)) test_perror("initialize local semaphore");
	deadlines(&local);
	if (sem_destroy(&local)) test_perror("destroy local semaphore");
	snprintf(name, sizeof(name), "/wasm-sem-deadline-%ld", (long)getpid());
	sem_t *named = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
	if (named == SEM_FAILED) test_perror("create deadline semaphore");
	/* Remove the name immediately; its open handle retains the object. */
	if (sem_unlink(name)) test_perror("unlink deadline semaphore");
	deadlines(named);
	if (sem_close(named)) test_perror("close deadline semaphore");
	puts("semaphore deadlines: named/unnamed past deadlines, invalid nanoseconds and token fast path verified");
	test_pass();
}
