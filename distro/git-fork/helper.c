// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define COPY_BUFFER_SIZE 4096U
#define HOOK_RECORD_SIZE 128U

static int
parse_decimal(const char *text, long *value)
{
  if (text == NULL || text[0] == '\0')
    return 0;

  for (const unsigned char *cursor = (const unsigned char *)text;
       *cursor != '\0'; cursor++)
    {
      if (*cursor < '0' || *cursor > '9')
        return 0;
    }

  errno = 0;
  char *end = NULL;
  long parsed = strtol(text, &end, 10);
  if (errno == ERANGE || end == text || *end != '\0')
    return 0;

  *value = parsed;
  return 1;
}

static int
append_hook_record(const char *path, pid_t pid, pid_t parent_pid)
{
  char record[HOOK_RECORD_SIZE];
  int length = snprintf(record, sizeof(record),
                        "hook child pid=%ld ppid=%ld\n", (long)pid,
                        (long)parent_pid);
  if (length < 0 || (size_t)length >= sizeof(record))
    {
      fprintf(stderr, "git-fork-helper: hook record is too long\n");
      return 1;
    }

  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd < 0)
    {
      perror("git-fork-helper: open hook log");
      return 1;
    }

  ssize_t written;
  do
    {
      written = write(fd, record, (size_t)length);
    }
  while (written < 0 && errno == EINTR);

  int saved_error = 0;
  if (written < 0)
    saved_error = errno;
  else if (written != length)
    saved_error = EIO;
  if (close(fd) < 0 && saved_error == 0)
    saved_error = errno;
  if (saved_error != 0)
    {
      errno = saved_error;
      perror("git-fork-helper: append hook record");
      return 1;
    }

  return 0;
}

static int
hook_mode(int argc, char **argv)
{
  long expected_parent;
  long requested_status;
  pid_t pid;
  pid_t parent_pid;

  if (argc != 5 || argv[2][0] == '\0'
      || !parse_decimal(argv[3], &expected_parent) || expected_parent <= 0
      || !parse_decimal(argv[4], &requested_status)
      || (requested_status != 0 && requested_status != 19))
    {
      fprintf(stderr,
              "usage: git-fork-helper hook LOG EXPECTED_PPID EXITCODE\n");
      return 2;
    }

  pid = getpid();
  parent_pid = getppid();
  if (pid <= 0 || parent_pid <= 0 || (long)parent_pid != expected_parent)
    {
      fprintf(stderr,
              "git-fork-helper: expected parent %ld, observed %ld\n",
              expected_parent, (long)parent_pid);
      return 1;
    }

  if (append_hook_record(argv[2], pid, parent_pid) != 0)
    return 1;
  return (int)requested_status;
}

static int
write_all(int fd, const unsigned char *buffer, size_t length)
{
  size_t written = 0;

  while (written < length)
    {
      ssize_t count = write(fd, buffer + written, length - written);
      if (count < 0 && errno == EINTR)
        continue;
      if (count <= 0)
        {
          if (count == 0)
            errno = EIO;
          return -1;
        }
      written += (size_t)count;
    }

  return 0;
}

static int
filter_mode(int argc)
{
  unsigned char buffer[COPY_BUFFER_SIZE];

  if (argc != 2)
    {
      fprintf(stderr, "usage: git-fork-helper filter\n");
      return 2;
    }

  for (;;)
    {
      ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
      if (count < 0 && errno == EINTR)
        continue;
      if (count < 0)
        {
          perror("git-fork-helper: read stdin");
          return 1;
        }
      if (count == 0)
        return 0;
      if (write_all(STDOUT_FILENO, buffer, (size_t)count) != 0)
        {
          perror("git-fork-helper: write stdout");
          return 1;
        }
    }
}

int
main(int argc, char **argv)
{
  if (argc >= 2 && strcmp(argv[1], "hook") == 0)
    return hook_mode(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "filter") == 0)
    return filter_mode(argc);

  fprintf(stderr, "usage: git-fork-helper hook LOG EXPECTED_PPID EXITCODE | filter\n");
  return 2;
}
