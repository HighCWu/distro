// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static _Thread_local volatile int tls_value = 23;

int main(int argc, char **argv)
{
	char *end;
	long parent;
	if (argc != 3 || strcmp(argv[1], "hello")) return 111;
	parent = strtol(argv[2], &end, 10);
	if (*end || parent <= 0 || parent != getppid() || getpid() == parent) return 112;
	if (!getenv("FORK_PROBE") || strcmp(getenv("FORK_PROBE"), "ready") || tls_value != 23) return 113;
	tls_value = 24;
	puts("fork-exec: arguments, environment, TLS and identity pass");
	return tls_value == 24 ? 37 : 114;
}
