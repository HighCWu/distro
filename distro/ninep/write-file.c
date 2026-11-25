/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/xattr.h>
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

static void require_timestamps(const char *path, struct timespec atime,
			       struct timespec mtime)
{
	struct stat observed;
	if (fstatat(AT_FDCWD, path, &observed, 0) != 0)
		fail("stat file timestamps");
	if (observed.st_atim.tv_sec != atime.tv_sec ||
	    observed.st_atim.tv_nsec != atime.tv_nsec ||
	    observed.st_mtim.tv_sec != mtime.tv_sec ||
	    observed.st_mtim.tv_nsec != mtime.tv_nsec) {
		errno = EPROTO;
		fail("exact file timestamps did not round-trip");
	}
}

static void verify_timestamps(const char *path)
{
	const struct timespec initial[2] = {
		{ .tv_sec = -271828182, .tv_nsec = 123456789 },
		{ .tv_sec = 1700000042, .tv_nsec = 987654321 },
	};
	if (utimensat(AT_FDCWD, path, initial, 0) != 0)
		fail("set signed seconds and exact nanoseconds");
	require_timestamps(path, initial[0], initial[1]);

	const struct timespec updated[2] = {
		{ .tv_nsec = UTIME_OMIT },
		{ .tv_sec = 1700000084, .tv_nsec = 456789123 },
	};
	if (utimensat(AT_FDCWD, path, updated, 0) != 0)
		fail("change mtime with atime omitted");
	require_timestamps(path, initial[0], updated[1]);
	puts("9p transport: preserved signed seconds and nanosecond timestamps");
}

static void verify_xattrs(const char *path)
{
	static const char name[] = "user.ninep-runtime";
	static const unsigned char replacement[] = { 0, 0xff, 0x83, 0x13, 0 };
	unsigned char value[9217], observed[sizeof(value)];
	for (size_t i = 0; i < sizeof(value); ++i)
		value[i] = (unsigned char)(i * 29 + (i >> 8));

	errno = 0;
	if (setxattr(path, name, replacement, sizeof(replacement), XATTR_REPLACE) != -1 ||
	    errno != ENODATA)
		fail("replace missing extended attribute must return ENODATA");
	if (setxattr(path, name, value, sizeof(value), XATTR_CREATE) != 0)
		fail("create binary extended attribute");
	errno = 0;
	if (setxattr(path, name, replacement, sizeof(replacement), XATTR_CREATE) != -1 ||
	    errno != EEXIST)
		fail("create duplicate extended attribute must return EEXIST");
	if (getxattr(path, name, NULL, 0) != sizeof(value) ||
	    getxattr(path, name, observed, sizeof(observed)) != sizeof(value) ||
	    memcmp(value, observed, sizeof(value)) != 0) {
		errno = EPROTO;
		fail("round-trip binary extended attribute");
	}

	if (setxattr(path, name, replacement, sizeof(replacement), XATTR_REPLACE) != 0)
		fail("replace binary extended attribute");
	if (getxattr(path, name, observed, sizeof(observed)) != sizeof(replacement) ||
	    memcmp(replacement, observed, sizeof(replacement)) != 0) {
		errno = EPROTO;
		fail("round-trip replacement extended attribute");
	}

	char names[512];
	ssize_t length = listxattr(path, names, sizeof(names));
	if (length < 0)
		fail("list extended attributes");
	int found = 0;
	const char *end = names + length;
	for (const char *cursor = names; cursor < end;) {
		const char *separator = memchr(cursor, '\0', (size_t)(end - cursor));
		if (!separator || separator == cursor) {
			errno = EPROTO;
			fail("invalid null-delimited extended attribute list");
		}
		if ((size_t)(separator - cursor) == sizeof(name) - 1 &&
		    memcmp(cursor, name, sizeof(name) - 1) == 0)
			found = 1;
		cursor = separator + 1;
	}
	if (!found) {
		errno = EPROTO;
		fail("find exact extended attribute name in list");
	}

	if (removexattr(path, name) != 0)
		fail("remove extended attribute");
	errno = 0;
	if (getxattr(path, name, NULL, 0) != -1 || errno != ENODATA)
		fail("read removed extended attribute must return ENODATA");
	verify_file(path, expected_byte(0));
	puts("9p transport: preserved user extended attributes");
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
	if (argc == 3) {
		verify_hard_link(argv[1], argv[2]);
		verify_timestamps(argv[1]);
		verify_xattrs(argv[1]);
	}
	return 0;
}
