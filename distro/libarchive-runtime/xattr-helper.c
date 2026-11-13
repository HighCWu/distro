// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/xattr.h>

#include <errno.h>
#include <stdio.h>
#include <string.h>

static const char attribute_name[] = "user.linux_wasm";
static const unsigned char expected_value[] = {
	0x00, 0x61, 0x72, 0x63, 0x68, 0x69, 0x76, 0x65, 0x00, 0xff, 0x7e
};

static int
check_value(const char *path)
{
	unsigned char actual[sizeof(expected_value)];
	ssize_t size = getxattr(path, attribute_name, NULL, 0);
	if (size < 0) {
		perror("getxattr(size)");
		return 1;
	}
	if ((size_t)size != sizeof(expected_value)) {
		fprintf(stderr, "xattr-helper: unexpected attribute size %zd\n", size);
		return 1;
	}

	size = getxattr(path, attribute_name, actual, sizeof(actual));
	if (size < 0) {
		perror("getxattr(value)");
		return 1;
	}
	if ((size_t)size != sizeof(expected_value) ||
		memcmp(actual, expected_value, sizeof(expected_value)) != 0) {
		fprintf(stderr, "xattr-helper: attribute bytes differ\n");
		return 1;
	}
	return 0;
}

int
main(int argc, char **argv)
{
	if (argc != 3 || (strcmp(argv[1], "set") != 0 &&
		strcmp(argv[1], "check") != 0)) {
		fprintf(stderr, "usage: %s set|check PATH\n", argv[0]);
		return 2;
	}

	if (strcmp(argv[1], "set") == 0) {
		if (setxattr(argv[2], attribute_name, expected_value,
			sizeof(expected_value), 0) != 0) {
			perror("setxattr");
			return 1;
		}
		if (check_value(argv[2]) != 0)
			return 1;
		puts("libarchive xattr: set/get user attribute verified");
		return 0;
	}

	if (check_value(argv[2]) != 0)
		return 1;
	puts("libarchive xattr: restored user attribute bytes verified");
	return 0;
}
