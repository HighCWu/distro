// SPDX-License-Identifier: MIT
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <sys/xattr.h>

static const char attribute_name[] = "user.rsync_fork_fixture";
static const unsigned char initial_value[] = {
    0x00, 0x72, 0x73, 0x79, 0x6e, 0x63, 0x00, 0xff, 0x31,
};
static const unsigned char updated_value[] = {
    0x00, 0x72, 0x73, 0x79, 0x6e, 0x63, 0x00, 0xfe, 0x32,
};

static int fail(const char *operation) {
  perror(operation);
  return 1;
}

static const unsigned char *expected_value(const char *name) {
  if (strcmp(name, "initial") == 0)
    return initial_value;
  if (strcmp(name, "updated") == 0)
    return updated_value;
  return NULL;
}

static int verify_value(const char *path, const unsigned char *expected) {
  unsigned char actual[sizeof(initial_value)];
  ssize_t size = getxattr(path, attribute_name, NULL, 0);

  if (size < 0)
    return fail("getxattr(size)");
  if ((size_t)size != sizeof(actual)) {
    fprintf(stderr, "rsync xattr fixture: unexpected value size %zd\n", size);
    return 1;
  }

  size = getxattr(path, attribute_name, actual, sizeof(actual));
  if (size < 0)
    return fail("getxattr(value)");
  if ((size_t)size != sizeof(actual) || memcmp(actual, expected, sizeof(actual)) != 0) {
    fprintf(stderr, "rsync xattr fixture: binary value differs\n");
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  const unsigned char *value;

  if (argc != 4 || (strcmp(argv[1], "set") != 0 && strcmp(argv[1], "check") != 0)) {
    fprintf(stderr, "usage: %s set|check PATH initial|updated\n", argv[0]);
    return 2;
  }
  value = expected_value(argv[3]);
  if (value == NULL) {
    fprintf(stderr, "rsync xattr fixture: unknown fixture value\n");
    return 2;
  }

  if (strcmp(argv[1], "set") == 0 &&
      setxattr(argv[2], attribute_name, value, sizeof(initial_value), 0) == -1)
    return fail("setxattr");
  if (verify_value(argv[2], value) != 0)
    return 1;
  return 0;
}
