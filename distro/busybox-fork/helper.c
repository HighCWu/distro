// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int
write_all (int fd, const char *bytes, size_t size)
{
  size_t written = 0;
  while (written < size)
    {
      ssize_t amount = write (fd, bytes + written, size - written);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount <= 0)
        return -1;
      written += (size_t) amount;
    }
  return 0;
}

static int
copy_stdin_to_stdout (void)
{
  char buffer[4096];
  for (;;)
    {
      ssize_t amount = read (STDIN_FILENO, buffer, sizeof buffer);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount < 0)
        return 1;
      if (amount == 0)
        return 0;
      if (write_all (STDOUT_FILENO, buffer, (size_t) amount) != 0)
        return 1;
    }
}

static int
echo_arguments (int argc, char **argv)
{
  for (int i = 2; i < argc; i++)
    {
      if (i != 2 && write_all (STDOUT_FILENO, " ", 1) != 0)
        return 1;
      if (write_all (STDOUT_FILENO, argv[i], strlen (argv[i])) != 0)
        return 1;
    }
  return write_all (STDOUT_FILENO, "\n", 1) == 0 ? 0 : 1;
}

static int
record_arguments (int argc, char **argv)
{
  if (argc < 4)
    return 2;

  char line[8192];
  int length = snprintf (line, sizeof line, "%s|%d", argv[3], argc - 4);
  if (length < 0 || (size_t) length >= sizeof line || strchr (argv[3], '|'))
    return 2;

  size_t used = (size_t) length;
  for (int i = 4; i < argc; i++)
    {
      if (strchr (argv[i], '|'))
        return 2;
      length = snprintf (line + used, sizeof line - used, "|%s", argv[i]);
      if (length < 0 || (size_t) length >= sizeof line - used)
        return 2;
      used += (size_t) length;
    }
  if (used + 1 >= sizeof line)
    return 2;
  line[used++] = '\n';

  int fd = open (argv[2], O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd < 0)
    return 3;
  int result = write_all (fd, line, used);
  int close_result = close (fd);
  if (result != 0 || close_result != 0)
    return 4;

  char response[256];
  length = snprintf (response, sizeof response, "record:%s\n", argv[3]);
  if (length < 0 || (size_t) length >= sizeof response
      || write_all (STDOUT_FILENO, response, (size_t) length) != 0)
    return 5;
  return 0;
}

static int
exit_with_status (int argc, char **argv)
{
  if (argc != 3)
    return 2;
  errno = 0;
  char *end = NULL;
  long status = strtol (argv[2], &end, 10);
  if (errno != 0 || end == argv[2] || *end != '\0' || status < 0
      || status > 255)
    return 2;
  return (int) status;
}

int
main (int argc, char **argv)
{
  if (argc < 2)
    return 2;
  if (strcmp (argv[1], "echo") == 0)
    return echo_arguments (argc, argv);
  if (strcmp (argv[1], "copy") == 0)
    return argc == 2 ? copy_stdin_to_stdout () : 2;
  if (strcmp (argv[1], "record") == 0)
    return record_arguments (argc, argv);
  if (strcmp (argv[1], "exit") == 0)
    return exit_with_status (argc, argv);
  return 2;
}
