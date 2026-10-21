/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
static volatile sig_atomic_t ordinary_count, info_count, bad;
static void ordinary(int sig) { if (sig == SIGUSR1) ordinary_count++; else bad = 1; }
static void information(int sig, siginfo_t *info, void *context)
{
	if (sig == SIGUSR2 && info && info->si_signo == sig && context) info_count++;
	else bad = 1;
}
int main(void)
{
	stack_t old;
	struct sigaction action = {.sa_handler = ordinary};
	int ok = sigaltstack(NULL, &old) == -1 && errno == EOPNOTSUPP &&
	         sigemptyset(&action.sa_mask) == 0 && sigaction(SIGUSR1, &action, NULL) == 0;
	action.sa_sigaction = information;
	action.sa_flags = SA_SIGINFO;
	ok = ok && sigaction(SIGUSR2, &action, NULL) == 0 && raise(SIGUSR1) == 0 && raise(SIGUSR2) == 0 &&
	     !bad && ordinary_count == 1 && info_count == 1;
	puts(ok ? "signal-stack-legacy: missing stack export refused and ordinary callbacks preserved pass" :
	          "::vm-test::fail: signal-stack-legacy: rejection or ordinary callbacks changed");
	if (ok) puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return ok ? 0 : 1;
}
