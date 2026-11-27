#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_pidfd_send_signal
#define SYS_pidfd_send_signal 424
#endif
#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_getfd
#define SYS_pidfd_getfd 438
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "pidfd-getfd-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int sys_pidfd_open(pid_t pid, unsigned int flags) {
  return (int)syscall(SYS_pidfd_open, pid, flags);
}

static int sys_pidfd_getfd(int pidfd, int targetfd, unsigned int flags) {
  return (int)syscall(SYS_pidfd_getfd, pidfd, targetfd, flags);
}

static int sys_pidfd_send_signal(int pidfd, int sig, siginfo_t *info,
                                 unsigned int flags) {
  return (int)syscall(SYS_pidfd_send_signal, pidfd, sig, info, flags);
}

int main(void) {
  pid_t self = getpid();
  int pfd = sys_pidfd_open(self, 0U);
  require(pfd >= 0, "pidfd_open(self)");

  int fd_flags = fcntl(pfd, F_GETFD);
  require(fd_flags >= 0 && (fd_flags & FD_CLOEXEC) != 0, "pidfd O_CLOEXEC");

  require(sys_pidfd_open((pid_t)999999, 0U) == -1 && errno == ESRCH,
          "pidfd_open(999999) ESRCH");
  require(sys_pidfd_open(self, 0x10000U) == -1 && errno == EINVAL,
          "pidfd_open invalid flags EINVAL");

  int pipefd[2];
  require(pipe2(pipefd, O_CLOEXEC) == 0, "pipe2");

  int dup_wr = sys_pidfd_getfd(pfd, pipefd[1], 0U);
  require(dup_wr >= 0 && dup_wr != pipefd[1], "pidfd_getfd(pipefd[1])");
  require(close(pipefd[1]) == 0, "close original pipefd[1]");

  const char msg[] = "pidfd-getfd-ok";
  require(write(dup_wr, msg, sizeof(msg) - 1) == (ssize_t)(sizeof(msg) - 1),
          "write dup_wr");

  char rbuf[32];
  require(read(pipefd[0], rbuf, sizeof(rbuf)) == (ssize_t)(sizeof(msg) - 1),
          "read pipefd[0]");
  require(memcmp(rbuf, msg, sizeof(msg) - 1) == 0, "pipe payload");

  require(sys_pidfd_getfd(pfd, 9999, 0U) == -1 && errno == EBADF,
          "pidfd_getfd invalid fd EBADF");
  require(sys_pidfd_getfd(pfd, pipefd[0], 1U) == -1 && errno == EINVAL,
          "pidfd_getfd invalid flags EINVAL");

  sigset_t set;
  require(sigemptyset(&set) == 0, "sigemptyset");
  require(sigaddset(&set, SIGUSR1) == 0, "sigaddset(SIGUSR1)");
  require(sigprocmask(SIG_BLOCK, &set, NULL) == 0, "sigprocmask(SIG_BLOCK)");

  siginfo_t uinfo;
  memset(&uinfo, 0, sizeof(uinfo));
  uinfo.si_signo = SIGUSR1;
  uinfo.si_code = SI_QUEUE;
  uinfo.si_pid = self;
  uinfo.si_uid = getuid();
  uinfo.si_value.sival_int = 0x55AA1234;

  require(sys_pidfd_send_signal(pfd, SIGUSR1, &uinfo, 0U) == 0,
          "pidfd_send_signal(SIGUSR1)");

  siginfo_t got;
  struct timespec to = {.tv_sec = 2, .tv_nsec = 0};
  int sig;
  do {
    sig = sigtimedwait(&set, &got, &to);
  } while (sig < 0 && errno == EINTR);
  require(sig == SIGUSR1 && got.si_code == SI_QUEUE &&
              got.si_value.sival_int == 0x55AA1234,
          "sigtimedwait pidfd_send_signal");

  require(close(dup_wr) == 0, "close dup_wr");
  require(close(pipefd[0]) == 0, "close pipefd[0]");
  require(close(pfd) == 0, "close pfd");

  printf("pidfd-getfd-runtime: ok pid=%d val=0x%x\n", (int)self,
         got.si_value.sival_int);
  return 0;
}
