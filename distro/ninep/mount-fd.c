/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
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

static int verify_file(const char *path)
{
	static const unsigned char expected[] = "linux-wasm 9p transport\n";
	const size_t expected_length = sizeof(expected) - 1;
	unsigned char buffer[sizeof(expected)];
	size_t offset = 0;
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		fail("open remote file");

	for (;;) {
		ssize_t count = read(fd, buffer, sizeof(buffer));
		if (count < 0) {
			if (errno == EINTR)
				continue;
			fail("read remote file");
		}
		if (count == 0)
			break;
		for (size_t i = 0; i < (size_t)count; i++, offset++) {
			if (offset == expected_length) {
				fprintf(stderr, "9p mount-fd: unexpected byte at offset %zu (0x%02x)\n",
					offset, (unsigned int)buffer[i]);
				return 1;
			}
			if (buffer[i] != expected[offset]) {
				fprintf(stderr, "9p mount-fd: byte mismatch at offset %zu (got 0x%02x, expected 0x%02x)\n",
					offset, (unsigned int)buffer[i], (unsigned int)expected[offset]);
				return 1;
			}
		}
	}
	if (close(fd) < 0)
		fail("close remote file");
	if (offset != expected_length) {
		fprintf(stderr, "9p mount-fd: EOF after %zu bytes (expected %zu)\n",
			offset, expected_length);
		return 1;
	}
	return 0;
}

int main(int argc, char **argv)
{
	if (argc == 3 && strcmp(argv[1], "--verify") == 0)
		return verify_file(argv[2]);

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
