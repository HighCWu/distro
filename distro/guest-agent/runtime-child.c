/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

_Static_assert(sizeof(void *) == 8 && sizeof(long) == 8,
	       "runtime child must use native wasm64");

static int echo_input(void)
{
	char buffer[4096];
	for (;;) {
		ssize_t size = read(STDIN_FILENO, buffer, sizeof(buffer));
		if (size == -1 && errno == EINTR)
			continue;
		if (size <= 0)
			return size ? 11 : 0;
		for (ssize_t offset = 0; offset < size;) {
			ssize_t written = write(STDOUT_FILENO, buffer + offset, size - offset);
			if (written == -1 && errno == EINTR)
				continue;
			if (written <= 0)
				return 12;
			offset += written;
		}
	}
}

int main(int argc, char **argv)
{
	if (argc < 2)
		return 10;
	if (!strcmp(argv[1], "echo")) {
		char directory[256];
		const char *value = getenv("AGENT_RUNTIME_VALUE");
		if (argc != 3 || !getcwd(directory, sizeof(directory)) || !value)
			return 13;
		fprintf(stderr, "abi=64 cwd=%s arg=%s env=%s\n", directory, argv[2], value);
		return echo_input();
	}
	if (!strcmp(argv[1], "exit"))
		return 23;
	if (!strcmp(argv[1], "wait")) {
		puts("ready");
		fflush(stdout);
		for (;;)
			pause();
	}
	return 14;
}
