// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static _Thread_local volatile int tls_value = 23;

int main(int argc, char **argv)
{
#ifdef __wasm__
	extern int raw_clone_refusal_probe(void);
	if (!raw_clone_refusal_probe()) return 118;
	puts("fork-exec: untransformed raw clone refusal pass");
#endif
	char *end;
	long parent;
	if (argc != 3 || strcmp(argv[1], "hello")) return 111;
	parent = strtol(argv[2], &end, 10);
	if (*end || parent <= 0 || parent != getppid() || getpid() == parent) return 112;
	if (!getenv("FORK_PROBE") || strcmp(getenv("FORK_PROBE"), "ready") || tls_value != 23) return 113;
	sigset_t mask;
	struct sigaction action;
	if (sigprocmask(SIG_SETMASK, NULL, &mask) || sigismember(&mask, SIGUSR1) != 1 ||
		sigaction(SIGUSR1, NULL, &action) || action.sa_handler != SIG_DFL) return 117;
	tls_value = 24;
	puts("fork-exec: inherited mask and reset handler pass");
	puts("fork-exec: arguments, environment, TLS and identity pass");
	return tls_value == 24 ? 37 : 114;
}
