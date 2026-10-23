/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <sched.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static sigjmp_buf landing;
static volatile sig_atomic_t mode, errors, outer_count, inner_count;
static void inner_plain(int sig)
{
	if (sig != SIGUSR2) errors = 1;
	if (mode == 2) {
		syscall(SYS_exit, 80UL, 0UL, 0UL, 0UL, 0UL, 0UL);
		__builtin_trap();
	}
	inner_count++;
	siglongjmp(landing, 43);
}
static void inner_info(int sig, siginfo_t *info, void *context)
{
	if (!info || info->si_signo != SIGUSR2 || !context) errors = 2;
	inner_plain(sig);
}
static void outer(int sig, siginfo_t *info, void *raw)
{
	ucontext_t *context = raw;
	if (sig != SIGUSR1 || !info || info->si_signo != sig || !context) errors = 3;
	if (mode == 2) {
		syscall(SYS_exit, 79UL, 0UL, 0UL, 0UL, 0UL, 0UL);
		__builtin_trap();
	}
	outer_count++;
	int value = sigsetjmp(landing, 1);
	if (!value) {
		if (raise(SIGUSR2)) errors = 4;
		errors = 5;
	} else if (value != 43) errors = 6;
	/* The outer handler is still live. Its restorer must retain this edit
	 * even though the inner signal frame was discarded by SjLj. */
	if (context && sigaddset(&context->uc_sigmask, SIGWINCH)) errors = 7;
}
static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: nested-signal: %s handler=%d\n", message, errors);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
static int child(void *argument)
{
	(void)raise((int)(uintptr_t)argument);
	return 92;
}
int main(void)
{
	struct sigaction action = {.sa_sigaction = outer, .sa_flags = SA_SIGINFO};
	require(!sigemptyset(&action.sa_mask) && !sigaction(SIGUSR1, &action, NULL), "outer action");
	sigset_t before, observed;
	require(!sigprocmask(SIG_SETMASK, NULL, &before), "initial mask");
	for (int kind = 0; kind < 2; kind++) {
		action.sa_flags = kind ? SA_SIGINFO : 0;
		if (kind) action.sa_sigaction = inner_info;
		else action.sa_handler = inner_plain;
		require(!sigaction(SIGUSR2, &action, NULL), "inner action");
		for (int round = 0; round < 8; round++) {
			require(!raise(SIGUSR1) && !errors, "outer handler return after inner SjLj");
			require(!sigprocmask(SIG_SETMASK, NULL, &observed) &&
			        sigismember(&observed, SIGWINCH) == 1 &&
			        sigismember(&observed, SIGUSR1) == 0 &&
			        sigismember(&observed, SIGUSR2) == 0, "outer context edit survived");
			require(!sigprocmask(SIG_SETMASK, &before, NULL), "restore caller mask");
		}
	}
	require(outer_count == 16 && inner_count == 16, "complete both handler forms");
	puts("signal-nested: inner SjLj retains outer context, mask edits and repeated delivery pass");
	const size_t stack_size = 65536;
	char *stack = malloc(stack_size);
	require(stack != NULL, "child stack");
	action.sa_handler = inner_plain;
	action.sa_flags = 0;
	require(!sigaction(SIGUSR2, &action, NULL), "plain exit action");
	mode = 2;
	const int signals[] = {SIGUSR1, SIGUSR2};
	for (unsigned i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
		int sig = signals[i];
		pid_t pid = clone(child, stack + stack_size, CLONE_VM | SIGCHLD, (void *)(uintptr_t)sig);
		require(pid > 0, "clone handler-exit child");
		int status;
		require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) &&
		        WEXITSTATUS(status) == (sig == SIGUSR1 ? 79 : 80), "handler exit preserves status");
	}
	mode = 0;
	free(stack);
	require(!raise(SIGUSR1) && !errors && outer_count == 17 && inner_count == 17,
	        "parent delivery after child handler exits");
	require(!sigprocmask(SIG_SETMASK, &before, NULL), "final mask cleanup");
	puts("signal-nested: siginfo/plain handler exit, child reap and parent recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
