// SPDX-License-Identifier: MIT
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int
write_all(int fd, const char *data, size_t length)
{
  size_t offset = 0;

  while (offset < length)
    {
      ssize_t count = write(fd, data + offset, length - offset);
      if (count < 0 && errno == EINTR)
        continue;
      if (count <= 0)
        {
          if (count == 0)
            errno = EIO;
          return -1;
        }
      offset += (size_t)count;
    }
  return 0;
}

static int
record_remote_child(const char *program)
{
  const char *path = getenv("RSYNC_FORK_CHILD_LOG");
  if (path == NULL || path[0] == '\0')
    return 0;

  char line[512];
  int length = snprintf(line, sizeof(line),
                        "rsh pid=%ld ppid=%ld host=localhost program=%s\n",
                        (long)getpid(), (long)getppid(), program);
  if (length < 0 || (size_t)length >= sizeof(line))
    {
      fprintf(stderr, "rsync-fork-helper: child record is too long\n");
      return 1;
    }

  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd < 0)
    {
      perror("rsync-fork-helper: open child log");
      return 1;
    }
  int result = write_all(fd, line, (size_t)length);
  int saved_error = result == 0 ? 0 : errno;
  if (close(fd) < 0 && saved_error == 0)
    saved_error = errno;
  if (saved_error != 0)
    {
      errno = saved_error;
      perror("rsync-fork-helper: write child log");
      return 1;
    }
  return 0;
}

static int
run_loopback_remote_shell(int argc, char **argv)
{
  if (argc < 4 || strcmp(argv[1], "localhost") != 0
      || argv[2][0] != '/')
    {
      fprintf(stderr,
              "rsync-fork-helper: expected localhost and an absolute rsync path\n");
      return 2;
    }

  const char *expected = getenv("RSYNC_FORK_PROGRAM");
  if (expected != NULL && strcmp(expected, argv[2]) != 0)
    {
      fprintf(stderr, "rsync-fork-helper: unexpected remote rsync path\n");
      return 2;
    }
  if (record_remote_child(argv[2]) != 0)
    return 1;

  execv(argv[2], &argv[2]);
  int saved_error = errno;
  errno = saved_error;
  perror("rsync-fork-helper: exec remote rsync");
  return saved_error == ENOENT ? 127 : 126;
}

static int
wait_for_rsync_child(pid_t child, int *child_status)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0)
    {
      perror("rsync-fork-helper: clock_gettime");
      return -1;
    }
  struct timespec deadline = { .tv_sec = now.tv_sec + 30,
                                .tv_nsec = now.tv_nsec };
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };

  for (;;)
    {
      pid_t waited = waitpid(child, child_status, WNOHANG);
      if (waited == child)
        return 0;
      if (waited < 0 && errno == EINTR)
        continue;
      if (waited < 0)
        {
          perror("rsync-fork-helper: waitpid rsync");
          return -1;
        }

      if (clock_gettime(CLOCK_MONOTONIC, &now) < 0)
        {
          perror("rsync-fork-helper: clock_gettime");
          return -1;
        }
      if (now.tv_sec > deadline.tv_sec
          || (now.tv_sec == deadline.tv_sec
              && now.tv_nsec >= deadline.tv_nsec))
        return 1;

      (void)nanosleep(&pause, NULL);
    }
}

static void
terminate_and_reap_rsync_group(pid_t process_group, pid_t main_child,
                               int *main_status)
{
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
  if (kill(-process_group, SIGTERM) < 0 && errno != ESRCH)
    perror("rsync-fork-helper: terminate rsync process group");
  if (kill(main_child, SIGTERM) < 0 && errno != ESRCH)
    perror("rsync-fork-helper: terminate rsync child");

  for (int grace = 0; grace < 50; grace++)
    {
      int status;
      pid_t waited = waitpid(-1, &status, WNOHANG);
      if (waited > 0)
        {
          if (waited == main_child)
            *main_status = status;
          continue;
        }
      if (waited < 0 && errno == ECHILD)
        return;
      if (waited < 0 && errno != EINTR)
        perror("rsync-fork-helper: waitpid during termination");
      (void)nanosleep(&pause, NULL);
    }

  if (kill(-process_group, SIGKILL) < 0 && errno != ESRCH)
    perror("rsync-fork-helper: kill rsync process group");
  if (kill(main_child, SIGKILL) < 0 && errno != ESRCH)
    perror("rsync-fork-helper: kill rsync child");

  for (;;)
    {
      int status;
      pid_t waited = waitpid(-1, &status, 0);
      if (waited > 0)
        {
          if (waited == main_child)
            *main_status = status;
          continue;
        }
      if (waited < 0 && errno == EINTR)
        continue;
      if (waited < 0 && errno == ECHILD)
        return;
      perror("rsync-fork-helper: waitpid after termination");
      return;
    }
}

static int
supervise_rsync(char **command)
{
  if (command[0] == NULL || command[0][0] != '/')
    {
      fprintf(stderr, "rsync-fork-helper: supervisor needs an absolute command\n");
      return 2;
    }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1L, 0L, 0L, 0L) < 0)
    {
      perror("rsync-fork-helper: PR_SET_CHILD_SUBREAPER");
      return 125;
    }

  pid_t child = fork();
  if (child < 0)
    {
      perror("rsync-fork-helper: fork supervisor child");
      return 125;
    }
  if (child == 0)
    {
      if (setpgid(0, 0) < 0)
        {
          perror("rsync-fork-helper: setpgid rsync");
          _exit(125);
        }
      execv(command[0], command);
      int saved_error = errno;
      errno = saved_error;
      perror("rsync-fork-helper: exec rsync");
      _exit(saved_error == ENOENT ? 127 : 126);
    }

  int child_status = 0;
  if (setpgid(child, child) < 0 && errno != EACCES && errno != ESRCH)
    {
      perror("rsync-fork-helper: setpgid rsync");
      terminate_and_reap_rsync_group(child, child, &child_status);
      return 125;
    }

  int wait_result = wait_for_rsync_child(child, &child_status);
  if (wait_result != 0)
    {
      if (wait_result > 0)
        fprintf(stderr,
                "rsync-fork-helper: rsync child timed out after 30 seconds\n");
      terminate_and_reap_rsync_group(child, child, &child_status);
      return 125;
    }

  int reaped_descendants = 0;
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
  int attempts = 0;
  for (;;)
    {
      int orphan_status;
      pid_t orphan = waitpid(-1, &orphan_status, WNOHANG);
      if (orphan > 0)
        {
          reaped_descendants++;
          continue;
        }
      if (orphan == 0)
        {
          if (attempts++ < 500)
            {
              (void)nanosleep(&pause, NULL);
              continue;
            }

          fprintf(stderr,
                  "rsync-fork-helper: rsync descendants did not exit within 5 seconds\n");
          if (kill(-child, SIGTERM) < 0 && errno != ESRCH)
            perror("rsync-fork-helper: terminate rsync descendants");
          for (int grace = 0; grace < 50; grace++)
            {
              pid_t stopped = waitpid(-1, &orphan_status, WNOHANG);
              if (stopped > 0)
                {
                  reaped_descendants++;
                  continue;
                }
              if (stopped < 0 && errno == ECHILD)
                return 125;
              if (stopped < 0 && errno != EINTR)
                {
                  perror("rsync-fork-helper: waitpid descendants");
                  break;
                }
              (void)nanosleep(&pause, NULL);
            }
          if (kill(-child, SIGKILL) < 0 && errno != ESRCH)
            perror("rsync-fork-helper: kill rsync descendants");
          for (;;)
            {
              pid_t stopped = waitpid(-1, &orphan_status, 0);
              if (stopped > 0)
                {
                  reaped_descendants++;
                  continue;
                }
              if (stopped < 0 && errno == EINTR)
                continue;
              if (stopped < 0 && errno == ECHILD)
                break;
              perror("rsync-fork-helper: waitpid descendants after kill");
              return 125;
            }
          return 125;
        }
      if (errno == EINTR)
        continue;
      if (errno == ECHILD)
        break;
      perror("rsync-fork-helper: waitpid descendants");
      return 125;
    }

  if (reaped_descendants != 0)
    fprintf(stderr, "rsync-fork-helper: reaped %d rsync descendant(s)\n",
            reaped_descendants);
  if (WIFEXITED(child_status))
    return WEXITSTATUS(child_status);
  if (WIFSIGNALED(child_status))
    return 128 + WTERMSIG(child_status);
  return 125;
}

int
main(int argc, char **argv)
{
  if (argc >= 2 && strcmp(argv[1], "--supervise") == 0)
    {
      if (argc < 3)
        {
          fprintf(stderr, "usage: rsync-fork-helper --supervise RSYNC [ARGS...]\n");
          return 2;
        }
      return supervise_rsync(&argv[2]);
    }
  return run_loopback_remote_shell(argc, argv);
}
