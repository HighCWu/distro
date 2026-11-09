// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static volatile int bss_state;
static _Thread_local volatile int tls_state;

enum bad_fixture
{
  BAD_TRUNCATED,
  BAD_VERSION,
  BAD_WASM_BODY,
};

static void
require (int ok, const char *what)
{
  if (ok)
    return;
  fprintf (stderr, "elf-container runtime: %s errno=%d\n", what, errno);
  exit (1);
}

static int
write_all (int fd, const void *data, size_t size)
{
  const char *bytes = data;
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
make_path (char *buffer, size_t capacity, const char *directory,
           const char *name)
{
  int length = snprintf (buffer, capacity, "%s/%s", directory, name);
  return length > 0 && (size_t) length < capacity ? 0 : -1;
}

static int
write_executable (const char *path, const void *data, size_t size)
{
  int fd = open (path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0700);
  if (fd < 0)
    return -1;
  int result = write_all (fd, data, size);
  if (result == 0 && fchmod (fd, 0700) != 0)
    result = -1;
  if (close (fd) != 0)
    result = -1;
  return result;
}

#if defined(__wasm__)
static void
put_u16 (unsigned char *destination, uint16_t value)
{
  destination[0] = (unsigned char) value;
  destination[1] = (unsigned char) (value >> 8);
}

static void
put_u32 (unsigned char *destination, uint32_t value)
{
  for (unsigned index = 0; index < 4; index++)
    destination[index] = (unsigned char) (value >> (index * 8));
}

static void
put_u64 (unsigned char *destination, uint64_t value)
{
  for (unsigned index = 0; index < 8; index++)
    destination[index] = (unsigned char) (value >> (index * 8));
}

static int
write_bad_fixture (const char *path, enum bad_fixture kind)
{
  static const unsigned char wasm_valid_prefix[8]
      = { 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00 };
  unsigned char file[168];
  memset (file, 0, sizeof file);

  file[0] = 0x7f;
  file[1] = 'E';
  file[2] = 'L';
  file[3] = 'F';
  file[4] = sizeof (uintptr_t) == 8 ? 2 : 1;
  file[5] = 1;
  file[6] = 1;
  file[7] = 3;
  if (kind == BAD_TRUNCATED)
    return write_executable (path, file, 8);

  const size_t module_size = kind == BAD_WASM_BODY ? 9 : 8;
  memcpy (file + (sizeof (uintptr_t) == 8 ? 120 : 84),
          "LINUX.WASM", 10);
  unsigned char *segment = file + (sizeof (uintptr_t) == 8 ? 120 : 84);
  put_u32 (segment + 12, kind == BAD_VERSION ? 2 : 1);
  put_u32 (segment + 16, (uint32_t) (sizeof (uintptr_t) * 8));
  put_u64 (segment + 24, module_size);
  memcpy (segment + 32, wasm_valid_prefix, sizeof wasm_valid_prefix);
  if (kind == BAD_WASM_BODY)
    segment[40] = 0xff;

  const uint32_t segment_type = UINT32_C (0x60005741);
  const uint32_t segment_size = (uint32_t) (32 + module_size);
  if (sizeof (uintptr_t) == 8)
    {
      put_u16 (file + 16, 2);
      put_u16 (file + 18, 0);
      put_u32 (file + 20, 1);
      put_u64 (file + 32, 64);
      put_u16 (file + 52, 64);
      put_u16 (file + 54, 56);
      put_u16 (file + 56, 1);

      unsigned char *program_header = file + 64;
      put_u32 (program_header, segment_type);
      put_u32 (program_header + 4, 4);
      put_u64 (program_header + 8, 120);
      put_u64 (program_header + 32, segment_size);
      put_u64 (program_header + 48, 4);
    }
  else
    {
      put_u16 (file + 16, 2);
      put_u16 (file + 18, 0);
      put_u32 (file + 20, 1);
      put_u32 (file + 28, 52);
      put_u16 (file + 40, 52);
      put_u16 (file + 42, 32);
      put_u16 (file + 44, 1);

      unsigned char *program_header = file + 52;
      put_u32 (program_header, segment_type);
      put_u32 (program_header + 4, 84);
      put_u32 (program_header + 16, segment_size);
      put_u32 (program_header + 24, 4);
      put_u32 (program_header + 28, 4);
    }
  return write_executable (path, file,
                           (sizeof (uintptr_t) == 8 ? 120 : 84) + segment_size);
}
#else
static int
write_bad_fixture (const char *path, enum bad_fixture kind)
{
  static const unsigned char truncated[]
      = { 0x7f, 'E', 'L', 'F', 2, 1, 1, 3 };
  static const unsigned char wrong_version[]
      = { 0x7f, 'E', 'L', 'F', 2, 1, 1, 3, 2, 0, 0, 0 };
  static const unsigned char invalid_wasm[]
      = { 0x7f, 'E', 'L', 'F', 0x00, 0x61, 0x73, 0x6d,
          0x01, 0x00, 0x00, 0x00, 0xff };
  switch (kind)
    {
    case BAD_TRUNCATED:
      return write_executable (path, truncated, sizeof truncated);
    case BAD_VERSION:
      return write_executable (path, wrong_version, sizeof wrong_version);
    case BAD_WASM_BODY:
      return write_executable (path, invalid_wasm, sizeof invalid_wasm);
    }
  errno = EINVAL;
  return -1;
}
#endif

static int
set_close_on_exec (int fd)
{
  int flags = fcntl (fd, F_GETFD);
  return flags < 0 ? -1 : fcntl (fd, F_SETFD, flags | FD_CLOEXEC);
}

static int
read_pipe_to_end (int fd, char *buffer, size_t capacity)
{
  size_t used = 0;
  int too_large = 0;
  for (;;)
    {
      char discard[128];
      char *destination = used < capacity ? buffer + used : discard;
      size_t available = used < capacity ? capacity - used : sizeof discard;
      ssize_t amount = read (fd, destination, available);
      if (amount < 0 && errno == EINTR)
        continue;
      if (amount < 0)
        return -1;
      if (amount == 0)
        break;
      if (used < capacity)
        used += (size_t) amount;
      else
        too_large = 1;
      if (used == capacity)
        too_large = 1;
    }
  if (too_large || used == 0)
    return -1;
  if (used >= capacity)
    return -1;
  buffer[used] = '\0';
  return 0;
}

static int
spawn_and_capture (const char *path, char *const child_argv[], pid_t *child_pid,
                   char *output, size_t output_capacity)
{
  int pipe_fds[2];
  if (pipe (pipe_fds) != 0)
    return -1;
  if (set_close_on_exec (pipe_fds[0]) != 0
      || set_close_on_exec (pipe_fds[1]) != 0)
    {
      close (pipe_fds[0]);
      close (pipe_fds[1]);
      return -1;
    }

  posix_spawn_file_actions_t actions;
  int result = posix_spawn_file_actions_init (&actions);
  if (result != 0)
    {
      close (pipe_fds[0]);
      close (pipe_fds[1]);
      errno = result;
      return -1;
    }
  result = posix_spawn_file_actions_adddup2 (&actions, pipe_fds[1],
                                             STDOUT_FILENO);
  if (result == 0)
    result = posix_spawn_file_actions_addclose (&actions, pipe_fds[0]);
  if (result == 0)
    result = posix_spawn_file_actions_addclose (&actions, pipe_fds[1]);
  if (result != 0)
    {
      posix_spawn_file_actions_destroy (&actions);
      close (pipe_fds[0]);
      close (pipe_fds[1]);
      errno = result;
      return -1;
    }

  result = posix_spawn (child_pid, path, &actions, NULL, child_argv, environ);
  posix_spawn_file_actions_destroy (&actions);
  close (pipe_fds[1]);
  if (result != 0)
    {
      close (pipe_fds[0]);
      errno = result;
      return -1;
    }

  int read_result = read_pipe_to_end (pipe_fds[0], output, output_capacity);
  int close_result = close (pipe_fds[0]);
  int child_status = 0;
  pid_t waited;
  do
    waited = waitpid (*child_pid, &child_status, 0);
  while (waited < 0 && errno == EINTR);
  return read_result == 0 && close_result == 0 && waited == *child_pid
                 && WIFEXITED (child_status) && WEXITSTATUS (child_status) == 0
             ? 0
             : -1;
}

static void
expect_report (const char *actual, const char *expected)
{
  require (strcmp (actual, expected) == 0,
           "child report did not match PID, PPID, argv or environment");
}

static int
raw_helper (int argc)
{
  require (argc == 2 && bss_state == 0 && tls_state == 0,
           "raw helper image did not reset BSS and TLS");
  char output[128];
  int length = snprintf (output, sizeof output, "raw pid=%ld ppid=%ld\n",
                         (long) getpid (), (long) getppid ());
  require (length >= 0 && (size_t) length < sizeof output
             && write_all (STDOUT_FILENO, output, (size_t) length) == 0,
           "raw helper could not report state");
  return 0;
}

int
main (int argc, char **argv)
{
  setvbuf (stdout, NULL, _IONBF, 0);
  if (argc >= 2 && strcmp (argv[1], "--raw-helper") == 0)
    return raw_helper (argc);
  require (argc == 2, "expected a temporary work directory");
  const char *helper = getenv ("ELF_CONTAINER_HELPER");
  if (helper == NULL || helper[0] == '\0')
    helper = "/bin/elf-container-helper";
  const char *work = argv[1];

  char inherited_path[PATH_MAX];
  require (make_path (inherited_path, sizeof inherited_path, work,
                      "inherited-fd-XXXXXX") == 0,
           "build inherited-file path");
  int inherited_fd = mkstemp (inherited_path);
  require (inherited_fd >= 0, "create inherited file");
  static const char prefix[] = "skip:";
  static const char payload[] = "inherited-fd-payload";
  require (write_all (inherited_fd, prefix, sizeof prefix - 1) == 0
             && write_all (inherited_fd, payload, sizeof payload - 1) == 0
             && lseek (inherited_fd, (off_t) (sizeof prefix - 1), SEEK_SET)
                    == (off_t) (sizeof prefix - 1),
           "prepare inherited descriptor offset");

  pid_t parent_pid = getpid ();
  char parent_text[32];
  char fd_text[32];
  require (snprintf (parent_text, sizeof parent_text, "%ld", (long) parent_pid)
                   > 0
             && snprintf (fd_text, sizeof fd_text, "%d", inherited_fd) > 0,
           "format child arguments");

  require (setenv ("ELF_CONTAINER_HELPER_PATH", helper, 1) == 0
             && setenv ("ELF_CONTAINER_PROBE", "spawn-env-value", 1) == 0,
           "set spawn probe environment");
  char *spawn_argv[] = { (char *) helper,
                         "--spawn-probe",
                         parent_text,
                         "argument with spaces",
                         "second-argument",
                         fd_text,
                         NULL };
  pid_t spawn_pid = 0;
  char child_output[512];
  require (spawn_and_capture (helper, spawn_argv, &spawn_pid, child_output,
                              sizeof child_output)
             == 0,
           "posix_spawn helper failed");
  char expected_spawn[256];
  int spawn_length
      = snprintf (expected_spawn, sizeof expected_spawn,
                  "spawn pid=%ld ppid=%ld argc=6 env=spawn-env-value\n",
                  (long) spawn_pid, (long) parent_pid);
  require (spawn_length >= 0 && (size_t) spawn_length < sizeof expected_spawn,
           "format expected spawn report");
  expect_report (child_output, expected_spawn);
  off_t expected_offset
      = (off_t) (sizeof prefix - 1 + sizeof payload - 1);
  require (lseek (inherited_fd, 0, SEEK_CUR) == expected_offset,
           "parent did not observe child read offset on inherited file");
  require (unsetenv ("ELF_CONTAINER_PROBE") == 0,
           "clear spawn probe environment");
  puts ("ELF container: posix_spawn argv environment PID PPID and inherited fd pass");

  require (setenv ("ELF_CONTAINER_PROBE", "fexec-env-value", 1) == 0,
           "set fexec probe environment");
  char *fexec_argv[] = { (char *) helper, "--fexec-probe", parent_text, NULL };
  pid_t fexec_pid = 0;
  require (spawn_and_capture (helper, fexec_argv, &fexec_pid, child_output,
                              sizeof child_output)
             == 0,
           "helper fexecve failed");
  char expected_fexec[256];
  int fexec_length
      = snprintf (expected_fexec, sizeof expected_fexec,
                  "fexec pid=%ld ppid=%ld bss=0 tls=0 fd=closed\n",
                  (long) fexec_pid, (long) parent_pid);
  require (fexec_length >= 0 && (size_t) fexec_length < sizeof expected_fexec,
           "format expected fexec report");
  expect_report (child_output, expected_fexec);
  require (unsetenv ("ELF_CONTAINER_PROBE") == 0,
           "clear fexec probe environment");
  puts ("ELF container: fexecve preserves PID and resets BSS TLS and CLOEXEC pass");

  bss_state = 0x13579;
  tls_state = 0x24680;
  pid_t original_pid = getpid ();
  char truncated_path[PATH_MAX];
  char version_path[PATH_MAX];
  char body_path[PATH_MAX];
  require (make_path (truncated_path, sizeof truncated_path, work,
                      "truncated-header") == 0
             && make_path (version_path, sizeof version_path, work,
                           "wrong-version") == 0
             && make_path (body_path, sizeof body_path, work,
                           "invalid-wasm-body") == 0
             && write_bad_fixture (truncated_path, BAD_TRUNCATED) == 0
             && write_bad_fixture (version_path, BAD_VERSION) == 0
             && write_bad_fixture (body_path, BAD_WASM_BODY) == 0,
           "create malformed executable fixtures");

  const char *bad_paths[] = { version_path, truncated_path, body_path };
  for (size_t index = 0; index < sizeof bad_paths / sizeof bad_paths[0]; index++)
    {
      char *bad_argv[] = { (char *) bad_paths[index], "must-not-run", NULL };
      errno = 0;
      int result = execve (bad_paths[index], bad_argv, environ);
      int exec_error = errno;
      require (result == -1 && exec_error == ENOEXEC,
               "malformed execve did not return ENOEXEC");
      require (getpid () == original_pid && bss_state == 0x13579
                 && tls_state == 0x24680,
               "rejected exec changed PID, BSS or TLS state");
      require (fcntl (inherited_fd, F_GETFD) >= 0,
               "rejected exec changed the original descriptor table");
    }

  require (setenv ("ELF_CONTAINER_PROBE", "recovery-env-value", 1) == 0,
           "set post-failure probe environment");
  char *recovery_argv[] = { (char *) helper,
                            "--recovery-probe",
                            parent_text,
                            "post-failure-child",
                            NULL };
  pid_t recovery_pid = 0;
  require (spawn_and_capture (helper, recovery_argv, &recovery_pid, child_output,
                              sizeof child_output)
             == 0,
           "normal ELF child execution did not recover after failed execve");
  char expected_recovery[256];
  int recovery_length
      = snprintf (expected_recovery, sizeof expected_recovery,
                  "recovery pid=%ld ppid=%ld argc=4 env=recovery-env-value\n",
                  (long) recovery_pid, (long) original_pid);
  require (recovery_length >= 0
             && (size_t) recovery_length < sizeof expected_recovery,
           "format expected recovery report");
  expect_report (child_output, expected_recovery);
  require (unsetenv ("ELF_CONTAINER_PROBE") == 0,
           "clear recovery probe environment");

  char *raw_argv[] = { argv[0], "--raw-helper", NULL };
  pid_t raw_pid = 0;
  require (spawn_and_capture (argv[0], raw_argv, &raw_pid, child_output,
                              sizeof child_output)
             == 0,
           "raw main self-execution did not recover after failed execve");
  char expected_raw[128];
  int raw_length = snprintf (expected_raw, sizeof expected_raw,
                             "raw pid=%ld ppid=%ld\n", (long) raw_pid,
                             (long) original_pid);
  require (raw_length >= 0 && (size_t) raw_length < sizeof expected_raw
             && strcmp (child_output, expected_raw) == 0,
           "raw self-exec child did not preserve PID ancestry or reset state");

  errno = 0;
  require (waitpid (-1, NULL, WNOHANG) == -1 && errno == ECHILD,
           "child process remained waitable after all waits");
  require (close (inherited_fd) == 0 && unlink (inherited_path) == 0
             && unlink (version_path) == 0 && unlink (truncated_path) == 0
             && unlink (body_path) == 0,
           "remove fixture files");
  puts ("ELF container: ENOEXEC rollback and raw/ELF exec recovery pass");
  return 0;
}
