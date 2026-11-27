#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "dnotify-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int wait_and_drain_dnotify(const sigset_t *set, int expected_fd,
                                  const char *stage) {
  siginfo_t si;
  struct timespec ts = {.tv_sec = 2, .tv_nsec = 0};
  int sig;
  for (;;) {
    sig = sigtimedwait(set, &si, &ts);
    if (sig < 0 && errno == EINTR) {
      continue;
    }
    break;
  }
  if (sig != SIGRTMIN) {
    fprintf(stderr, "dnotify-runtime: %s sigtimedwait failed sig=%d errno=%d\n",
            stage, sig, errno);
    exit(1);
  }
  if (si.si_signo != SIGRTMIN || si.si_fd != expected_fd) {
    fprintf(stderr,
            "dnotify-runtime: %s mismatch signo=%d fd=%d (expected %d)\n",
            stage, si.si_signo, si.si_fd, expected_fd);
    exit(1);
  }

  int count = 1;
  struct timespec zero_ts = {.tv_sec = 0, .tv_nsec = 0};
  for (;;) {
    sig = sigtimedwait(set, &si, &zero_ts);
    if (sig < 0) {
      if (errno == EINTR) {
        continue;
      }
      require(errno == EAGAIN, "drain sigtimedwait");
      break;
    }
    require(si.si_signo == SIGRTMIN && si.si_fd == expected_fd,
            "drain mismatch");
    count++;
  }
  return count;
}

int main(void) {
  const char *dir_path = "/tmp/dnotify_dir";
  const char *path_a = "/tmp/dnotify_dir/a.txt";
  const char *path_b = "/tmp/dnotify_dir/b.txt";

  sigset_t set;
  require(sigemptyset(&set) == 0, "sigemptyset");
  require(sigaddset(&set, SIGRTMIN) == 0, "sigaddset(SIGRTMIN)");
  require(sigprocmask(SIG_BLOCK, &set, NULL) == 0, "sigprocmask(SIG_BLOCK)");

  if (mkdir(dir_path, 0755) != 0) {
    require(errno == EEXIST, "mkdir(/tmp/dnotify_dir)");
  }

  int dir_fd = open(dir_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(dir_fd >= 0, "open(/tmp/dnotify_dir)");

  require(fcntl(dir_fd, F_SETSIG, SIGRTMIN) == 0, "fcntl(F_SETSIG)");
  require(fcntl(dir_fd, F_NOTIFY,
                DN_CREATE | DN_DELETE | DN_MODIFY | DN_RENAME | DN_MULTISHOT) ==
              0,
          "fcntl(F_NOTIFY)");

  int fd = open(path_a, O_CREAT | O_RDWR | O_CLOEXEC, 0644);
  require(fd >= 0, "open(a.txt)");
  int c1 = wait_and_drain_dnotify(&set, dir_fd, "create");

  const char msg[] = "hello-dnotify\n";
  require(write(fd, msg, sizeof(msg) - 1) == (ssize_t)(sizeof(msg) - 1),
          "write(a.txt)");
  require(close(fd) == 0, "close(a.txt)");
  int c2 = wait_and_drain_dnotify(&set, dir_fd, "modify");

  require(rename(path_a, path_b) == 0, "rename(a.txt -> b.txt)");
  int c3 = wait_and_drain_dnotify(&set, dir_fd, "rename");

  require(unlink(path_b) == 0, "unlink(b.txt)");
  int c4 = wait_and_drain_dnotify(&set, dir_fd, "delete");

  require(close(dir_fd) == 0, "close(dir_fd)");
  require(rmdir(dir_path) == 0, "rmdir(/tmp/dnotify_dir)");

  printf("dnotify-runtime: ok dir_fd=%d events=%d,%d,%d,%d\n", dir_fd, c1, c2,
         c3, c4);
  return 0;
}
