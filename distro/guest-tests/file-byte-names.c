// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char raw_name[] = "byte-\x80";
static const char replacement_name[] = "byte-\xef\xbf\xbd";
static const char raw_directory_name[] = "created-\xff";
static const char raw_file_name[] = "entry-\xfe";
static const char raw_renamed_name[] = "renamed-\xfd";
static const char raw_link_name[] = "link-\xfc";
static const char raw_file_contents[] = "temporary raw-name data\n";
static const char raw_contents[] = "raw-byte-80\n";
static const char replacement_contents[] = "utf8-replacement\n";

static void
require (int ok, const char *what)
{
  if (ok)
    return;
  fprintf (stderr, "file bytes: %s errno=%d\n", what, errno);
  exit (1);
}

static int
read_matches (int directory_fd, const char *name, const char *expected)
{
  int fd = openat (directory_fd, name, O_RDONLY | O_CLOEXEC);
  if (fd < 0)
    return 0;

  size_t expected_size = strlen (expected);
  char actual[64];
  if (expected_size > sizeof actual)
    {
      close (fd);
      return 0;
    }

  size_t position = 0;
  while (position < expected_size)
    {
      ssize_t amount = read (fd, actual + position, expected_size - position);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount <= 0)
        {
          close (fd);
          return 0;
        }
      position += (size_t) amount;
    }

  char extra;
  ssize_t extra_amount;
  do
    extra_amount = read (fd, &extra, 1);
  while (extra_amount < 0 && errno == EINTR);

  int close_result = close (fd);
  return close_result == 0 && extra_amount == 0
         && memcmp (actual, expected, expected_size) == 0;
}

static int
write_all (int fd, const char *contents, size_t size)
{
  size_t position = 0;
  while (position < size)
    {
      ssize_t amount = write (fd, contents + position, size - position);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount <= 0)
        return 0;
      position += (size_t) amount;
    }
  return 1;
}

static int
directory_has_only_original_names (int directory_fd)
{
  int scan_fd = openat (directory_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (scan_fd < 0)
    return 0;
  DIR *directory = fdopendir (scan_fd);
  if (directory == NULL)
    {
      close (scan_fd);
      return 0;
    }

  unsigned raw_count = 0;
  unsigned replacement_count = 0;
  unsigned other_count = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir (directory)) != NULL)
    {
      if (strcmp (entry->d_name, ".") == 0
          || strcmp (entry->d_name, "..") == 0)
        continue;
      if (strcmp (entry->d_name, raw_name) == 0)
        raw_count++;
      else if (strcmp (entry->d_name, replacement_name) == 0)
        replacement_count++;
      else
        other_count++;
    }
  int read_result = errno == 0;
  int close_result = closedir (directory);
  return read_result && close_result == 0 && raw_count == 1
         && replacement_count == 1 && other_count == 0;
}

static int
same_file_identity (const struct stat *left, const struct stat *right)
{
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
         && left->st_mode == right->st_mode && left->st_size == right->st_size;
}

int
main (int argc, char **argv)
{
  require (argc == 2, "expected shared directory path");
  int directory_fd = open (argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require (directory_fd >= 0, "open shared directory");

  struct stat replacement_before;
  require (read_matches (directory_fd, raw_name, raw_contents)
             && read_matches (directory_fd, replacement_name,
                              replacement_contents)
             && fstatat (directory_fd, replacement_name, &replacement_before, 0)
                    == 0
             && directory_has_only_original_names (directory_fd),
           "raw and replacement-name files remain distinct");
  puts ("file bytes: distinct raw and replacement names remain exact pass");

  require (mkdirat (directory_fd, raw_directory_name, 0700) == 0,
           "mkdirat raw-byte directory");
  int child_fd = openat (directory_fd, raw_directory_name,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require (child_fd >= 0, "openat raw-byte directory");

  int child_file_fd = openat (child_fd, raw_file_name,
                              O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  require (child_file_fd >= 0, "openat raw-byte file");
  require (write_all (child_file_fd, raw_file_contents,
                      sizeof raw_file_contents - 1)
             && close (child_file_fd) == 0,
           "write raw-byte file");
  require (renameat (child_fd, raw_file_name, child_fd, raw_renamed_name) == 0,
           "renameat raw-byte file");

  struct stat moved_file;
  require (fstatat (child_fd, raw_renamed_name, &moved_file, 0) == 0
             && S_ISREG (moved_file.st_mode)
             && moved_file.st_size == (off_t) (sizeof raw_file_contents - 1),
           "stat renamed raw-byte file");
  require (symlinkat (raw_renamed_name, child_fd, raw_link_name) == 0,
           "symlinkat raw-byte target");
  char link_target[sizeof raw_renamed_name];
  ssize_t link_size
      = readlinkat (child_fd, raw_link_name, link_target, sizeof link_target);
  require (link_size == (ssize_t) (sizeof raw_renamed_name - 1)
             && memcmp (link_target, raw_renamed_name,
                        sizeof raw_renamed_name - 1)
                    == 0,
           "readlinkat preserves raw target bytes");
  require (read_matches (child_fd, raw_link_name, raw_file_contents),
           "openat through raw-byte symlink");

  struct stat replacement_after_operations;
  require (fstatat (directory_fd, replacement_name,
                    &replacement_after_operations, 0)
                 == 0
             && same_file_identity (&replacement_before,
                                    &replacement_after_operations)
             && read_matches (directory_fd, replacement_name,
                              replacement_contents),
           "raw-byte operations leave replacement-name file unchanged");
  puts ("file bytes: raw names survive directory and relative mutations pass");

  require (unlinkat (child_fd, raw_link_name, 0) == 0
             && unlinkat (child_fd, raw_renamed_name, 0) == 0
             && close (child_fd) == 0
             && unlinkat (directory_fd, raw_directory_name, AT_REMOVEDIR) == 0,
           "unlinkat raw-byte entries and remove directory");
  struct stat replacement_after_cleanup;
  require (directory_has_only_original_names (directory_fd)
             && fstatat (directory_fd, replacement_name,
                         &replacement_after_cleanup, 0)
                    == 0
             && same_file_identity (&replacement_before,
                                    &replacement_after_cleanup)
             && read_matches (directory_fd, raw_name, raw_contents)
             && read_matches (directory_fd, replacement_name,
                              replacement_contents)
             && close (directory_fd) == 0,
           "cleanup preserves both original byte-name files");
  puts ("file bytes: cleanup preserves the replacement-name file pass");
  puts ("::vm-test::pass");
  return 0;
}
