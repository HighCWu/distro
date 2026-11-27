/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <grp.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc < 2 || setgroups(0, NULL) || setgid(65534) || setuid(65534) ||
	    getuid() != 65534 || geteuid() != 65534 || getgid() != 65534 || getegid() != 65534) {
		perror("crypto tools unprivileged exec setup");
		return 1;
	}
	execv(argv[1], argv + 1);
	perror("crypto tools unprivileged exec");
	return 1;
}
