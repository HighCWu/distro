/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
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

static void verify_file(const char *path, unsigned char first_byte)
{
	unsigned char bytes[FIRST_CHUNK];
	int fd = open(path, O_RDONLY | O_CLOEXEC);
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
			unsigned char expected = offset == 0 ? first_byte : expected_byte(offset);
			if (offset >= FILE_BYTES || bytes[i] != expected) {
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
}

static void write_first_byte(int fd, unsigned char value)
{
	ssize_t count;
	do {
		count = pwrite(fd, &value, 1, 0);
	} while (count < 0 && errno == EINTR);
	if (count != 1) {
		if (count >= 0)
			errno = EIO;
		fail("write first byte through alias");
	}
}

static void verify_hard_link(const char *path, const char *alias)
{
	struct stat original, linked, remaining;
	if (linkat(AT_FDCWD, path, AT_FDCWD, alias, 0) != 0)
		fail("create hard-link alias");
	if (stat(path, &original) != 0 || stat(alias, &linked) != 0)
		fail("stat both hard-link paths");
	if (original.st_dev != linked.st_dev || original.st_ino != linked.st_ino ||
	    original.st_nlink != 2 || linked.st_nlink != 2) {
		errno = EPROTO;
		fail("hard-link paths do not share a two-link inode");
	}

	int fd = open(alias, O_WRONLY | O_CLOEXEC);
	if (fd < 0)
		fail("open hard-link alias for writing");
	unsigned char changed = expected_byte(0) ^ 0xff;
	write_first_byte(fd, changed);
	verify_file(path, changed);
	write_first_byte(fd, expected_byte(0));
	if (close(fd) != 0)
		fail("close hard-link alias");

	if (unlink(alias) != 0)
		fail("unlink hard-link alias");
	if (lstat(alias, &remaining) == 0 || errno != ENOENT) {
		errno = EPROTO;
		fail("hard-link alias remains after unlink");
	}
	if (stat(path, &remaining) != 0)
		fail("stat original after unlinking alias");
	if (remaining.st_dev != original.st_dev || remaining.st_ino != original.st_ino ||
	    remaining.st_nlink != 1) {
		errno = EPROTO;
		fail("original inode or link count changed unexpectedly");
	}
	verify_file(path, expected_byte(0));
	puts("9p transport: linked, shared writes and unlinked an exact alias");
}

int main(int argc, char **argv)
{
	if (argc != 2 && argc != 3) {
		errno = EINVAL;
		fail("expected output file path and optional hard-link alias");
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

	verify_file(argv[1], expected_byte(0));
	puts("9p transport: created, wrote, appended and reopened exact remote file bytes");
	if (argc == 3)
		verify_hard_link(argv[1], argv[2]);
	return 0;
}
