// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

static volatile int bss_state;
static _Thread_local volatile int tls_state;

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
report_error (const char *message)
{
  dprintf (STDERR_FILENO, "elf-container helper: %s (errno=%d)\n", message,
           errno);
  return 1;
}

static int
parse_number (const char *text, long *value)
{
  errno = 0;
  char *end = NULL;
  long parsed = strtol (text, &end, 10);
  if (errno != 0 || end == text || *end != '\0')
    return -1;
  *value = parsed;
  return 0;
}

static int
spawn_probe (int argc, char **argv)
{
  long expected_parent;
  long descriptor_number;
  const char *expected_payload = "inherited-fd-payload";
  if (argc != 6 || parse_number (argv[2], &expected_parent) != 0
      || parse_number (argv[5], &descriptor_number) != 0
      || strcmp (argv[3], "argument with spaces") != 0
      || strcmp (argv[4], "second-argument") != 0)
    return report_error ("posix_spawn argv was changed");

  const char *expected_path = getenv ("ELF_CONTAINER_HELPER_PATH");
  const char *probe = getenv ("ELF_CONTAINER_PROBE");
  if (expected_path == NULL || strcmp (argv[0], expected_path) != 0
      || probe == NULL || strcmp (probe, "spawn-env-value") != 0
      || getppid () != (pid_t) expected_parent)
    return report_error ("posix_spawn argv0, environment or parent was changed");

  int fd = (int) descriptor_number;
  int descriptor_flags = fcntl (fd, F_GETFD);
  if (fd < 0 || descriptor_flags < 0 || (descriptor_flags & FD_CLOEXEC) != 0)
    return report_error ("inherited descriptor is missing or close-on-exec");

  size_t expected_size = strlen (expected_payload);
  char contents[64];
  size_t position = 0;
  while (position < expected_size)
    {
      ssize_t amount = read (fd, contents + position, expected_size - position);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount <= 0)
        return report_error ("inherited descriptor contents were truncated");
      position += (size_t) amount;
    }
  char extra;
  ssize_t extra_amount;
  do
    extra_amount = read (fd, &extra, 1);
  while (extra_amount < 0 && errno == EINTR);
  if (extra_amount != 0 || memcmp (contents, expected_payload, expected_size) != 0)
    return report_error ("inherited descriptor content or offset was changed");

  char response[192];
  int length = snprintf (response, sizeof response,
                         "spawn pid=%ld ppid=%ld argc=%d env=spawn-env-value\n",
                         (long) getpid (), (long) getppid (), argc);
  if (length < 0 || (size_t) length >= sizeof response
      || write_all (STDOUT_FILENO, response, (size_t) length) != 0)
    return report_error ("could not report posix_spawn state");
  return 0;
}

static int
recovery_probe (int argc, char **argv)
{
  long expected_parent;
  const char *probe = getenv ("ELF_CONTAINER_PROBE");
  if (argc != 4 || parse_number (argv[2], &expected_parent) != 0
      || strcmp (argv[3], "post-failure-child") != 0
      || probe == NULL || strcmp (probe, "recovery-env-value") != 0
      || getppid () != (pid_t) expected_parent)
    return report_error ("post-failure ELF child argv, environment or parent changed");

  char response[192];
  int length = snprintf (response, sizeof response,
                         "recovery pid=%ld ppid=%ld argc=%d env=recovery-env-value\n",
                         (long) getpid (), (long) getppid (), argc);
  if (length < 0 || (size_t) length >= sizeof response
      || write_all (STDOUT_FILENO, response, (size_t) length) != 0)
    return report_error ("could not report recovery child state");
  return 0;
}

static int
fexec_child (int argc, char **argv)
{
  long descriptor_number;
  long expected_pid;
  long expected_parent;
  if (argc != 5 || parse_number (argv[2], &descriptor_number) != 0
      || parse_number (argv[3], &expected_pid) != 0
      || parse_number (argv[4], &expected_parent) != 0)
    return report_error ("fexecve child argv was changed");
  if (bss_state != 0 || tls_state != 0 || getpid () != (pid_t) expected_pid
      || getppid () != (pid_t) expected_parent)
    return report_error ("fexecve did not preserve pid or reset BSS and TLS");

  errno = 0;
  if (fcntl ((int) descriptor_number, F_GETFD) != -1 || errno != EBADF)
    return report_error ("fexecve descriptor survived its close-on-exec flag");

  char response[192];
  int length = snprintf (response, sizeof response,
                         "fexec pid=%ld ppid=%ld bss=0 tls=0 fd=closed\n",
                         (long) getpid (), (long) getppid ());
  if (length < 0 || (size_t) length >= sizeof response
      || write_all (STDOUT_FILENO, response, (size_t) length) != 0)
    return report_error ("could not report fexecve state");
  return 0;
}

static int
fexec_probe (int argc, char **argv)
{
  long expected_parent;
  if (argc != 3 || parse_number (argv[2], &expected_parent) != 0
      || getppid () != (pid_t) expected_parent)
    return report_error ("fexecve parent argument was changed");

  int fd = open (argv[0], O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return report_error ("could not open helper for fexecve");
  int descriptor_flags = fcntl (fd, F_GETFD);
  if (descriptor_flags < 0 || (descriptor_flags & FD_CLOEXEC) == 0)
    return report_error ("fexecve descriptor is not close-on-exec");

  bss_state = 0x13579;
  tls_state = 0x24680;
  char fd_text[32];
  char pid_text[32];
  char parent_text[32];
  if (snprintf (fd_text, sizeof fd_text, "%d", fd) < 0
      || snprintf (pid_text, sizeof pid_text, "%ld", (long) getpid ()) < 0
      || snprintf (parent_text, sizeof parent_text, "%ld", (long) getppid ()) < 0)
    return report_error ("could not format fexecve child arguments");

  char *child_argv[] = { argv[0], "--fexec-child", fd_text, pid_text,
                         parent_text, NULL };
  fexecve (fd, child_argv, environ);
  return report_error ("fexecve of helper carrier failed");
}

int
main (int argc, char **argv)
{
  if (argc >= 2 && strcmp (argv[1], "--spawn-probe") == 0)
    return spawn_probe (argc, argv);
  if (argc >= 2 && strcmp (argv[1], "--fexec-probe") == 0)
    return fexec_probe (argc, argv);
  if (argc >= 2 && strcmp (argv[1], "--fexec-child") == 0)
    return fexec_child (argc, argv);
  if (argc >= 2 && strcmp (argv[1], "--recovery-probe") == 0)
    return recovery_probe (argc, argv);
  return report_error ("unknown invocation mode");
}
