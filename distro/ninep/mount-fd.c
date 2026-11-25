/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <unistd.h>

enum { HOST_PORT = 18109 };

static void fail(const char *stage)
{
	fprintf(stderr, "9p mount-fd: %s (errno=%d)\n", stage, errno);
	exit(1);
}

int main(int argc, char **argv)
{
	if (argc != 2 || argv[1][0] != '/' || strpbrk(argv[1], ",\r\n")) {
		errno = EINVAL;
		fail("expected one absolute 9P export name");
	}

	int fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		fail("open AF_VSOCK stream");
	struct sockaddr_vm host = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_HOST,
		.svm_port = HOST_PORT,
	};
	if (connect(fd, (struct sockaddr *)&host, sizeof(host)) < 0)
		fail("connect to host server");

	char options[4096];
	int length = snprintf(options, sizeof(options),
			      "trans=fd,rfdno=%d,wfdno=%d,version=9p2000.L,cache=none,access=any,aname=%s",
			      fd, fd, argv[1]);
	if (length < 0 || (size_t)length >= sizeof(options)) {
		errno = ENAMETOOLONG;
		fail("format mount options");
	}
	if (mount("host", "/mnt/9p", "9p", MS_RDONLY, options) < 0)
		fail("mount read-only 9P export");

	/* trans=fd acquired its own references for both directions during mount. */
	if (close(fd) < 0)
		fail("close userspace socket descriptor");
	return 0;
}
