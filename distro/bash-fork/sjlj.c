// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L
#include <setjmp.h>
#include <signal.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile int tls = 17;
static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: fork-sjlj: %s\n", message);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
__attribute__((noinline)) static void bounce(sigjmp_buf env, int code)
{
	/* User code after syscall return, not a kernel/signal callback jump. */
	siglongjmp(env, code);
}
static void zero_jump(void)
{
	jmp_buf env;
	switch (setjmp(env)) {
	case 0: longjmp(env, 0);
	case 1: return;
	default: require(0, "longjmp zero must become one");
	}
}
int main(void)
{
	const pid_t parent = getpid();
	volatile pid_t spawned = -1;
	volatile int local = 31;
	sigset_t one, original, observed;
	sigemptyset(&one);
	sigaddset(&one, SIGUSR1);
	require(sigprocmask(SIG_BLOCK, &one, &original) == 0, "save original signal mask");
	sigjmp_buf env;
	/* Use a controlling expression, as required by the C setjmp contract.
	 * Values changed between checkpoint and jump and used later are volatile. */
	switch (sigsetjmp(env, 1)) {
	case 0:
		spawned = fork();
		require(spawned >= 0, "fork inside saved C frame");
		require(sigprocmask(SIG_UNBLOCK, &one, NULL) == 0, "change mask before jump");
		local = spawned ? 51 : 53;
		tls = spawned ? 41 : 43;
		bounce(env, spawned ? 7 : 9);
		require(0, "siglongjmp returned normally");
		break;
	case 7:
		require(getpid() == parent && spawned > 0 && local == 51 && tls == 41,
			"parent jump identity, volatile local and TLS");
		break;
	case 9:
		require(getpid() != parent && getppid() == parent && spawned == 0 && local == 53 && tls == 43,
			"child jump identity, volatile local and TLS");
		require(sigprocmask(SIG_SETMASK, NULL, &observed) == 0 && sigismember(&observed, SIGUSR1) == 1,
			"child jump restores signal mask");
		_exit(37);
	default:
		require(0, "unexpected sigsetjmp result");
	}
	require(sigprocmask(SIG_SETMASK, NULL, &observed) == 0 && sigismember(&observed, SIGUSR1) == 1,
		"parent jump restores signal mask");
	int status;
	require(waitpid(spawned, &status, 0) == spawned && WIFEXITED(status) && WEXITSTATUS(status) == 37,
		"single child wait after nonlocal jump");
	require(sigprocmask(SIG_SETMASK, &original, NULL) == 0, "restore original mask");
	puts("fork-sjlj: siglongjmp after fork restores frames, masks and private TLS pass");
	zero_jump();
	pid_t later = fork();
	require(later >= 0, "later fork after nonlocal jumps");
	if (!later) _exit(tls == 41 && local == 51 ? 39 : 119);
	require(waitpid(later, &status, 0) == later && WIFEXITED(status) && WEXITSTATUS(status) == 39,
		"later fork and wait preserve parent state");
	puts("fork-sjlj: longjmp zero normalization and later fork/wait recovery pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
