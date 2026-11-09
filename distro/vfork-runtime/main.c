// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define HELPER_REPORT_MAGIC 0x56464f52U
#define EXPECTED_TOKEN "vfork-runtime-env-v1"
#define EXPECTED_OFFSET 5
#define EXPECTED_CHILD_EXIT 73

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

static int atfork_pipe = -1;
static volatile sig_atomic_t parent_atfork_calls;
static const char *helper_path;

static void
record_atfork(char event)
{
  if (write(atfork_pipe, &event, 1) != 1)
    _exit(124);
}

static void
atfork_prepare(void)
{
  parent_atfork_calls++;
  record_atfork('P');
}

static void
atfork_parent(void)
{
  parent_atfork_calls++;
  record_atfork('R');
}

static void
atfork_child(void)
{
  record_atfork('C');
}

static void
require(int condition, const char *what)
{
  if (condition)
    return;
  fprintf(stderr, "vfork-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int
read_exact(int fd, void *buffer, size_t length)
{
  char *bytes = buffer;
  size_t done = 0;
  while (done < length) {
    ssize_t count = read(fd, bytes + done, length - done);
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      return -1;
    done += (size_t)count;
  }
  return 0;
}

static pid_t
wait_for_child(pid_t child, int *status)
{
  pid_t result;
  do {
    result = waitpid(child, status, 0);
  } while (result < 0 && errno == EINTR);
  return result;
}

static int
atfork_pipe_is_empty(int fd)
{
  char event;
  ssize_t result = read(fd, &event, sizeof(event));
  return result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
}

int
main(int argc, char **argv)
{
  helper_path = argc > 1 ? argv[1] : getenv("VFORK_RUNTIME_HELPER");
  if (helper_path == NULL || helper_path[0] == '\0')
    helper_path = "/bin/vfork-helper";
  require(argc <= 2, "unexpected command-line arguments");
  setvbuf(stdout, NULL, _IONBF, 0);

  static const char missing_program[] =
      "/no-such-vfork-runtime-executable/vfork-child";
  errno = 0;
  require(access(missing_program, F_OK) < 0 && errno == ENOENT,
          "missing-exec fixture must not exist");

  int data_fd = -1;
  char file_name[] = "/tmp/vfork-runtime-data.XXXXXX";
  data_fd = mkstemp(file_name);
  require(data_fd >= 0, "create inherited file descriptor");
  require(unlink(file_name) == 0, "unlink inherited file fixture");
  static const char file_data[] = "0123456789";
  require(write(data_fd, file_data, sizeof(file_data) - 1) ==
              (ssize_t)(sizeof(file_data) - 1),
          "write inherited file fixture");
  require(lseek(data_fd, 2, SEEK_SET) == 2, "set inherited file offset");

  int report_pipe[2];
  require(pipe(report_pipe) == 0, "create helper report pipe");
  int hook_pipe[2];
  require(pipe(hook_pipe) == 0, "create atfork observation pipe");
  int hook_flags = fcntl(hook_pipe[0], F_GETFL);
  require(hook_flags >= 0 &&
              fcntl(hook_pipe[0], F_SETFL, hook_flags | O_NONBLOCK) == 0,
          "make atfork observation nonblocking");
  atfork_pipe = hook_pipe[1];
  require(pthread_atfork(atfork_prepare, atfork_parent, atfork_child) == 0,
          "register pthread_atfork handlers");
  require(setenv("VFORK_RUNTIME_TOKEN", EXPECTED_TOKEN, 1) == 0,
          "set helper environment fixture");

  int *exec_errno = &errno;
  pid_t failed_child = vfork();
  if (failed_child == 0) {
    execl(missing_program, missing_program, (char *)NULL);
    _exit(*exec_errno == ENOENT ? EXPECTED_CHILD_EXIT : 126);
  }
  require(failed_child > 0, "vfork before missing exec");
  int failed_status = 0;
  require(wait_for_child(failed_child, &failed_status) == failed_child &&
              WIFEXITED(failed_status) &&
              WEXITSTATUS(failed_status) == EXPECTED_CHILD_EXIT,
          "wait for exact _exit after failed exec");
  puts("vfork runtime: failed exec child _exit and parent wait pass");

  char parent_text[32];
  char report_fd_text[32];
  char data_fd_text[32];
  pid_t parent_pid = getpid();
  require(snprintf(parent_text, sizeof(parent_text), "%ld", (long)parent_pid) > 0,
          "format expected parent pid");
  require(snprintf(report_fd_text, sizeof(report_fd_text), "%d", report_pipe[1]) > 0,
          "format helper report descriptor");
  require(snprintf(data_fd_text, sizeof(data_fd_text), "%d", data_fd) > 0,
          "format inherited file descriptor");

  pid_t child = vfork();
  if (child == 0) {
    execl(helper_path, helper_path, "vfork-helper-argv", parent_text, report_fd_text,
          data_fd_text, (char *)NULL);
    _exit(125);
  }
  require(child > 0, "vfork and exec helper after failed exec");
  require(close(report_pipe[1]) == 0,
          "close parent report-pipe write end after vfork");
  report_pipe[1] = -1;
  int status = 0;
  require(wait_for_child(child, &status) == child && WIFEXITED(status) &&
              WEXITSTATUS(status) == 0,
          "wait for helper after successful exec");

  struct helper_report report;
  require(read_exact(report_pipe[0], &report, sizeof(report)) == 0,
          "read helper report");
  require(report.magic == HELPER_REPORT_MAGIC && report.argv_ok &&
              report.env_ok && report.fd_ok,
          "helper validated argv, environment and inherited descriptor");
  require(report.pid == child && report.ppid == parent_pid,
          "helper pid and ppid match the waited child and parent");
  require(report.input_fd == data_fd && report.offset == EXPECTED_OFFSET &&
              memcmp(report.bytes, "234", sizeof(report.bytes)) == 0 &&
              lseek(data_fd, 0, SEEK_CUR) == EXPECTED_OFFSET,
          "helper observed and advanced the inherited open-file offset");
  puts("vfork runtime: helper argv/env/pid/ppid and inherited fd offset pass");

  require(parent_atfork_calls == 0 && atfork_pipe_is_empty(hook_pipe[0]),
          "vfork did not run pthread_atfork handlers");
  puts("vfork runtime: post-failure vfork/exec recovery and atfork hooks pass");

  close(data_fd);
  close(report_pipe[0]);
  if (report_pipe[1] >= 0)
    close(report_pipe[1]);
  close(hook_pipe[0]);
  close(hook_pipe[1]);
  return 0;
}
