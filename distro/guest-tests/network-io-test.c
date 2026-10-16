/* SPDX-License-Identifier: MIT */
/* Compile the actual fixture helpers with deterministic syscall responses. */
#define main network_fixture_main
#define read fixture_read
#define write fixture_write
#include "network-test.c"
#undef main
#undef read
#undef write
#include <assert.h>

static unsigned char captured[16];
static size_t captured_length;
static int writes, reads, zero_write;

ssize_t fixture_write(int fd, const void *buffer, size_t length)
{
	(void)fd;
	if (zero_write)
		return 0;
	if (writes++ == 0) {
		errno = EINTR;
		return -1;
	}
	if (length > 2)
		length = 2;
	assert(captured_length + length <= sizeof(captured));
	memcpy(captured + captured_length, buffer, length);
	captured_length += length;
	return length;
}

ssize_t fixture_read(int fd, void *buffer, size_t length)
{
	(void)fd;
	if (reads++ == 0) {
		errno = EINTR;
		return -1;
	}
	assert(length >= 1);
	*(char *)buffer = 'x';
	return 1;
}

int main(int argc, char **argv)
{
	(void)argv;
	zero_write = argc > 1;
	write_all(1, "abcdefg", 7);
	assert(captured_length == 7 && memcmp(captured, "abcdefg", 7) == 0);
	char byte = 0;
	assert(read_retry(0, &byte, 1) == 1 && byte == 'x' && reads == 2);
	return 0;
}
