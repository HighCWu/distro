/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error Namespace fixture is only for an isolated Wasm machine, never the build host
#endif
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc != 2) return 100;
	int status = 0;
	if (unshare(CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWNET) != 0 ||
	    sethostname(argv[1], strlen(argv[1])) != 0)
		status = 101;
	int ready = open("/tmp/ns-ready", O_WRONLY | O_CLOEXEC);
	if (ready < 0) return 102;
	const char *message = status ? "failed\n" : "ready\n";
	if (write(ready, message, strlen(message)) != (ssize_t)strlen(message) || close(ready) != 0)
		return 103;
	if (status) return status;
	int release = open("/tmp/ns-release", O_RDONLY | O_CLOEXEC);
	if (release < 0) return 104;
	char token[8];
	size_t done = 0;
	while (done < sizeof token) {
		ssize_t n = read(release, token + done, sizeof token - done);
		if (n < 0 && errno == EINTR) continue;
		if (n <= 0) return 105;
		done += n;
	}
	return close(release) == 0 && !memcmp(token, "release\n", sizeof token) ? 0 : 106;
}
