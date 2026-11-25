/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

enum { INITIAL_BYTES = 12289, APPEND_BYTES = 257,
       FILE_BYTES = INITIAL_BYTES + APPEND_BYTES,
       FIRST_CHUNK = 8192, SMALL_CHUNK = 113 };

static void fail(const char *stage)
{
	fprintf(stderr, "9p write-file: %s (errno=%d)\n", stage, errno);
	exit(1);
}

static unsigned char expected_byte(size_t offset)
{
	return (unsigned char)((offset * 37 + 11) % 251);
}

int main(int argc, char **argv)
{
	if (argc != 2) {
		errno = EINVAL;
		fail("expected output file path");
	}
	unsigned char bytes[FIRST_CHUNK];
	int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	if (fd < 0)
		fail("create output file");
	for (size_t offset = 0; offset < INITIAL_BYTES;) {
		size_t length = offset == 0 ? FIRST_CHUNK : SMALL_CHUNK;
		if (length > INITIAL_BYTES - offset)
			length = INITIAL_BYTES - offset;
		for (size_t i = 0; i < length; ++i)
			bytes[i] = expected_byte(offset + i);
		size_t written = 0;
		while (written < length) {
			ssize_t count = write(fd, bytes + written, length - written);
			if (count < 0 && errno == EINTR)
				continue;
			if (count <= 0)
				fail("write output file");
			written += (size_t)count;
		}
		offset += length;
	}
	if (close(fd) != 0)
		fail("close written file");

	fd = open(argv[1], O_WRONLY | O_APPEND | O_CLOEXEC);
	if (fd < 0)
		fail("reopen output for append");
	if (lseek(fd, 0, SEEK_SET) != 0)
		fail("seek append descriptor to start");
	for (size_t i = 0; i < APPEND_BYTES; ++i)
		bytes[i] = expected_byte(INITIAL_BYTES + i);
	for (size_t written = 0; written < APPEND_BYTES;) {
		ssize_t count = write(fd, bytes + written, APPEND_BYTES - written);
		if (count < 0 && errno == EINTR)
			continue;
		if (count <= 0)
			fail("append output file");
		written += (size_t)count;
	}
	if (close(fd) != 0)
		fail("close appended file");

	fd = open(argv[1], O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		fail("reopen output file");
	size_t offset = 0;
	for (;;) {
		ssize_t count = read(fd, bytes, sizeof(bytes));
		if (count < 0 && errno == EINTR)
			continue;
		if (count < 0)
			fail("read output file");
		if (count == 0)
			break;
		for (size_t i = 0; i < (size_t)count; ++i, ++offset) {
			if (offset >= FILE_BYTES || bytes[i] != expected_byte(offset)) {
				errno = EPROTO;
				fail("output byte mismatch");
			}
		}
	}
	if (offset != FILE_BYTES) {
		errno = EPROTO;
		fail("output length mismatch");
	}
	if (close(fd) != 0)
		fail("close verified file");
	puts("9p transport: created, wrote, appended and reopened exact remote file bytes");
	return 0;
}
