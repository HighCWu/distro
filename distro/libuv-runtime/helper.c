// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  static const char output[] = "libuv-helper: argv verified\n";

  if (argc != 3 || strcmp(argv[1], "spawn-check") != 0 ||
      strcmp(argv[2], "argv-ok") != 0)
    return 90;

  if (write(STDOUT_FILENO, output, sizeof(output) - 1) !=
      (ssize_t)(sizeof(output) - 1))
    return 91;

  return 7;
}
