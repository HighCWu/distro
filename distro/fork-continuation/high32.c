// SPDX-License-Identifier: MIT
// Dedicated high-layout single-thread fork test, not a default linker policy.
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile int tls = 41;
static volatile int global = 17;
static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: fork-high32: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

int main(void)
{
	volatile int local = 43;
#ifdef __wasm__
	_Static_assert(sizeof(void *) == 4, "dedicated wasm32 layout");
	/* Private execution ABI inspection only; application fork still uses libc. */
	extern uintptr_t __wasm_fork_descriptor(void);
	require((uintptr_t)&local >= UINT32_C(0x80000000) &&
		(uintptr_t)&tls >= UINT32_C(0x80000000) &&
		(uintptr_t)&global >= UINT32_C(0x80000000) &&
		__wasm_fork_descriptor() >= UINT32_C(0x80000000), "actual high stack, TLS, data and descriptor");
	puts("fork-high32: upper-half stack, TLS, globals and execution descriptor pass");
#endif
	pid_t parent = getpid();
	pid_t child = fork();
	require(child >= 0, "fork from high layout");
	if (!child) {
		int valid = getpid() > 0 && getpid() != parent && getppid() == parent &&
			tls == 41 && global == 17 && local == 43;
		tls = 51; global = 71; local = 53;
		_exit(valid && tls == 51 && global == 71 && local == 53 ? 37 : 119);
	}
	int status = 0;
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
		"child continuation, identity and private data");
	require(tls == 41 && global == 17 && local == 43, "parent private state survives fork");
	errno = 0;
	require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single high-layout child reap");
	puts("fork-high32: fork continuation, private data and single child reap pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
