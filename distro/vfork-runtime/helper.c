// SPDX-License-Identifier: MIT

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define HELPER_REPORT_MAGIC 0x56464f52U
#define EXPECTED_TOKEN "vfork-runtime-env-v1"

struct helper_report {
  uint32_t magic;
  pid_t pid;
  pid_t ppid;
  int argv_ok;
  int env_ok;
  int fd_ok;
  int input_fd;
  off_t offset;
  char bytes[3];
};

static int
parse_int(const char *text, int *value)
{
  char *end;
  errno = 0;
  long parsed = strtol(text, &end, 10);
  if (errno != 0 || text == end || *end != '\0' || parsed < 0 ||
      parsed > 0x7fffffffL)
    return -1;
  *value = (int)parsed;
  return 0;
}

static long
parse_long(const char *text, long *value)
{
  char *end;
  errno = 0;
  long parsed = strtol(text, &end, 10);
  if (errno != 0 || text == end || *end != '\0')
    return -1;
  *value = parsed;
  return 0;
}

static int
write_all(int fd, const void *buffer, size_t length)
{
  const char *bytes = buffer;
  size_t done = 0;
  while (done < length) {
    ssize_t count = write(fd, bytes + done, length - done);
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      return -1;
    done += (size_t)count;
  }
  return 0;
}

int
main(int argc, char **argv)
{
  struct helper_report report = {0};
  int report_fd = -1;
  int input_fd = -1;
  long expected_parent = -1;
  report.magic = HELPER_REPORT_MAGIC;
  report.pid = getpid();
  report.ppid = getppid();

  report.argv_ok = argc == 5 && strcmp(argv[1], "vfork-helper-argv") == 0 &&
                   parse_long(argv[2], &expected_parent) == 0 &&
                   expected_parent == (long)report.ppid &&
                   parse_int(argv[3], &report_fd) == 0 &&
                   parse_int(argv[4], &input_fd) == 0;
  report.input_fd = input_fd;

  const char *token = getenv("VFORK_RUNTIME_TOKEN");
  report.env_ok = token != NULL && strcmp(token, EXPECTED_TOKEN) == 0;

  if (report.argv_ok) {
    char bytes[sizeof(report.bytes)];
    ssize_t count = read(input_fd, bytes, sizeof(bytes));
    report.offset = lseek(input_fd, 0, SEEK_CUR);
    report.fd_ok = count == (ssize_t)sizeof(bytes) &&
                   memcmp(bytes, "234", sizeof(bytes)) == 0 &&
                   report.offset == 5;
    if (count == (ssize_t)sizeof(bytes))
      memcpy(report.bytes, bytes, sizeof(bytes));
  }

  if (report.argv_ok && write_all(report_fd, &report, sizeof(report)) != 0)
    return 90;
  return report.argv_ok && report.env_ok && report.fd_ok ? 0 : 91;
}
