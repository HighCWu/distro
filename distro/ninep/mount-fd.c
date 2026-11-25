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

	int memory = argc == 2 && strcmp(argv[1], "--memory") == 0;
	if (argc != 1 && !memory) {
		errno = EINVAL;
		fail("expected --memory or no mount arguments");
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

	char export_name[4096] = "fs1";
	if (!memory) {
		size_t used = 0;
		for (;;) {
			char byte;
			ssize_t count = read(fd, &byte, 1);
			if (count < 0 && errno == EINTR)
				continue;
			if (count != 1)
				fail("read temporary export name");
			if (byte == '\n')
				break;
			if (used == sizeof(export_name) - 1 || byte == '\0' || byte == ',' || byte == '\r') {
				errno = EINVAL;
				fail("invalid temporary export name");
			}
			export_name[used++] = byte;
		}
		export_name[used] = '\0';
		if (used == 0 || export_name[0] != '/') {
			errno = EINVAL;
			fail("temporary export name must be absolute");
		}
	}

	char options[4096];
	int length = snprintf(options, sizeof(options),
			      "trans=fd,rfdno=%d,wfdno=%d,version=9p2000.L,cache=none,access=any,aname=%s",
			      fd, fd, export_name);
	if (length < 0 || (size_t)length >= sizeof(options)) {
		errno = ENAMETOOLONG;
		fail("format mount options");
	}
	if (mount("host", "/mnt/9p", "9p", 0, options) < 0)
		fail("mount writable 9P export");

	/* trans=fd acquired its own references for both directions during mount. */
	if (close(fd) < 0)
		fail("close userspace socket descriptor");
	return 0;
}
