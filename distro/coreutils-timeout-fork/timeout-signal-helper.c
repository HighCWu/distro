// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t term_seen;

static void
record_term(int signal_number)
{
  if (signal_number == SIGTERM)
    term_seen = 1;
}

static int
write_marker(const char *path)
{
  static const char marker[] = "SIGTERM\n";
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0)
    {
      perror("timeout-signal-helper: open marker");
      return -1;
    }

  size_t offset = 0;
  while (offset < sizeof(marker) - 1)
    {
      ssize_t written = write(fd, marker + offset, sizeof(marker) - 1 - offset);
      if (written < 0 && errno == EINTR)
        continue;
      if (written <= 0)
        {
          if (written == 0)
            errno = EIO;
          perror("timeout-signal-helper: write marker");
          close(fd);
          return -1;
        }
      offset += (size_t)written;
    }

  if (close(fd) < 0)
    {
      perror("timeout-signal-helper: close marker");
      return -1;
    }
  return 0;
}

static int
signal_loop(const char *marker_path, int exit_after_term, int exit_status)
{
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = record_term;
  if (sigemptyset(&action.sa_mask) < 0
      || sigaction(SIGTERM, &action, NULL) < 0)
    {
      perror("timeout-signal-helper: sigaction");
      return 70;
    }

  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC, &start) < 0)
    {
      perror("timeout-signal-helper: clock_gettime");
      return 71;
    }

  volatile unsigned long work = 1;
  int marker_written = 0;
  for (;;)
    {
      work = work * 33UL + 17UL;
      if (term_seen && !marker_written)
        {
          if (write_marker(marker_path) < 0)
            return 72;
          marker_written = 1;
          if (exit_after_term)
            return exit_status;
        }

      if ((work & 0xffffUL) == 0)
        {
          struct timespec now;
          if (clock_gettime(CLOCK_MONOTONIC, &now) < 0)
            {
              perror("timeout-signal-helper: clock_gettime");
              return 73;
            }
          if (now.tv_sec - start.tv_sec >= 8)
            {
              fprintf(stderr, "timeout-signal-helper: self-limit expired\n");
              return 99;
            }
        }
    }
}

static int
parse_status(const char *text, int *status)
{
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value < 0 || value > 255)
    return -1;
  *status = (int)value;
  return 0;
}

int
main(int argc, char **argv)
{
  if (argc == 3 && strcmp(argv[1], "--print") == 0)
    {
      puts(argv[2]);
      return 0;
    }

  int status;
  if (argc == 3 && strcmp(argv[1], "--exit") == 0)
    {
      if (parse_status(argv[2], &status) == 0)
        return status;
      fprintf(stderr, "timeout-signal-helper: invalid exit status\n");
      return 64;
    }

  if (argc == 4 && strcmp(argv[1], "--term-exit") == 0)
    {
      if (parse_status(argv[3], &status) == 0)
        return signal_loop(argv[2], 1, status);
      fprintf(stderr, "timeout-signal-helper: invalid exit status\n");
      return 64;
    }

  if (argc == 3 && strcmp(argv[1], "--ignore-term") == 0)
    return signal_loop(argv[2], 0, 0);

  fprintf(stderr,
          "usage: timeout-signal-helper --print TEXT | --exit STATUS | "
          "--term-exit MARKER STATUS | --ignore-term MARKER\n");
  return 64;
}
