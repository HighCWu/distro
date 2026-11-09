/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static int
write_all (int fd, const char *buffer, size_t size)
{
  while (size)
    {
      ssize_t written = write (fd, buffer, size);
      if (written < 0)
	{
	  if (errno == EINTR)
	    continue;
	  return -1;
	}
      if (written == 0)
	return -1;
      buffer += written;
      size -= (size_t) written;
    }
  return 0;
}

static int
log_event (const char *format, ...)
{
  const char *path = getenv ("TAR_FORK_LOG");
  char line[4096];
  va_list arguments;
  int fd;
  int write_status;
  int close_status;
  int length;

  if (!path || !*path)
    return -1;
  va_start (arguments, format);
  length = vsnprintf (line, sizeof line, format, arguments);
  va_end (arguments);
  if (length < 0 || (size_t) length >= sizeof line)
    return -1;
  fd = open (path, O_WRONLY | O_CREAT | O_APPEND, 0666);
  if (fd < 0)
    return -1;
  write_status = write_all (fd, line, (size_t) length);
  close_status = close (fd);
  if (write_status < 0 || close_status < 0)
    return -1;
  return 0;
}

static int
copy_stream (int input, int output)
{
  char buffer[8192];

  for (;;)
    {
      ssize_t count = read (input, buffer, sizeof buffer);
      if (count < 0)
	{
	  if (errno == EINTR)
	    continue;
	  return -1;
	}
      if (count == 0)
	return 0;
      if (write_all (output, buffer, (size_t) count) < 0)
	{
	  /* A consumer may stop after tar's end-of-archive records.  That is a
	     normal close for a pass-through decompressor.  */
	  if (errno == EPIPE)
	    return 0;
	  return -1;
	}
    }
}

static int
filter_mode (int argc, char **argv, int failing)
{
  const char *direction = "compress";
  int i;

  for (i = 2; i < argc; i++)
    {
      if (strcmp (argv[i], "-d") == 0)
	direction = "decompress";
      else
	return 64;
    }

  if (log_event ("%s pid=%ld ppid=%ld direction=%s\n",
		 failing ? "filter-fail" : "filter",
		 (long) getpid (), (long) getppid (), direction) < 0)
    return 65;
  if (copy_stream (STDIN_FILENO, STDOUT_FILENO) < 0)
    return 74;
  return failing ? 37 : 0;
}

static int
member_mode (void)
{
  const char *filename = getenv ("TAR_FILENAME");
  const char *size = getenv ("TAR_SIZE");
  const char *filetype = getenv ("TAR_FILETYPE");
  const char *data_path = getenv ("TAR_FORK_DATA");
  int fd;

  if (!filename || !size || !filetype || !data_path || !*data_path)
    return 66;
  if (log_event ("member pid=%ld ppid=%ld filename=%s size=%s type=%s\n",
		 (long) getpid (), (long) getppid (), filename, size,
		 filetype) < 0)
    return 65;
  fd = open (data_path, O_WRONLY | O_CREAT | O_TRUNC, 0666);
  if (fd < 0)
    return 67;
  if (copy_stream (STDIN_FILENO, fd) < 0)
    {
      close (fd);
      return 74;
    }
  if (close (fd) < 0)
    return 74;
  return 0;
}

static int
checkpoint_mode (void)
{
  const char *filename = getenv ("TAR_FILENAME");
  const char *checkpoint = getenv ("TAR_CHECKPOINT");

  if (filename || !checkpoint || !*checkpoint)
    return 68;
  if (log_event ("checkpoint pid=%ld ppid=%ld filename=unset checkpoint=%s\n",
		 (long) getpid (), (long) getppid (), checkpoint) < 0)
    return 65;
  return 0;
}

int
main (int argc, char **argv)
{
  /* Treat an early archive-reader close as an ordinary pipe shutdown. */
  (void) signal (SIGPIPE, SIG_IGN);

  if (argc == 2 && strcmp (argv[1], "filter") == 0)
    return filter_mode (argc, argv, 0);
  if (argc == 2 && strcmp (argv[1], "filter-fail") == 0)
    return filter_mode (argc, argv, 1);
  if (argc == 3 && strcmp (argv[1], "filter") == 0)
    return filter_mode (argc, argv, 0);
  if (argc == 3 && strcmp (argv[1], "filter-fail") == 0)
    return filter_mode (argc, argv, 1);
  if (argc == 2 && strcmp (argv[1], "member") == 0)
    return member_mode ();
  if (argc == 2 && strcmp (argv[1], "checkpoint") == 0)
    return checkpoint_mode ();
  fprintf (stderr, "tar-fork-helper: invalid invocation\n");
  return 64;
}
