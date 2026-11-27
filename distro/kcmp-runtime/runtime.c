#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/kcmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_kcmp
#define SYS_kcmp 272
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "kcmp-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int sys_kcmp(pid_t pid1, pid_t pid2, int type, unsigned long idx1,
                    unsigned long idx2) {
  return (int)syscall(SYS_kcmp, pid1, pid2, type, idx1, idx2);
}

int main(void) {
  pid_t self = getpid();

  require(sys_kcmp(self, self, KCMP_VM, 0, 0) == 0, "KCMP_VM self");
  require(sys_kcmp(self, self, KCMP_FILES, 0, 0) == 0, "KCMP_FILES self");
  require(sys_kcmp(self, self, KCMP_FS, 0, 0) == 0, "KCMP_FS self");
  require(sys_kcmp(self, self, KCMP_SIGHAND, 0, 0) == 0, "KCMP_SIGHAND self");

  int pfd[2];
  require(pipe2(pfd, O_CLOEXEC) == 0, "pipe2");
  int dup_rd = dup(pfd[0]);
  require(dup_rd >= 0 && dup_rd != pfd[0], "dup(pfd[0])");

  require(sys_kcmp(self, self, KCMP_FILE, (unsigned long)pfd[0],
                   (unsigned long)dup_rd) == 0,
          "KCMP_FILE same open file");
  int diff = sys_kcmp(self, self, KCMP_FILE, (unsigned long)pfd[0],
                      (unsigned long)pfd[1]);
  require(diff == 1 || diff == 2, "KCMP_FILE distinct pipe ends");

  int epfd = epoll_create1(EPOLL_CLOEXEC);
  require(epfd >= 0, "epoll_create1");
  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN;
  ev.data.fd = pfd[0];
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, pfd[0], &ev) == 0, "epoll_ctl add");

  struct kcmp_epoll_slot slot;
  memset(&slot, 0, sizeof(slot));
  slot.efd = (uint32_t)epfd;
  slot.tfd = (uint32_t)pfd[0];
  slot.toff = 0U;
  require(sys_kcmp(self, self, KCMP_EPOLL_TFD, (unsigned long)dup_rd,
                   (unsigned long)(uintptr_t)&slot) == 0,
          "KCMP_EPOLL_TFD matches dup_rd");

  require(sys_kcmp((pid_t)999999, self, KCMP_VM, 0, 0) == -1 &&
              errno == ESRCH,
          "kcmp(999999) ESRCH");
  require(sys_kcmp(self, self, 999, 0, 0) == -1 && errno == EINVAL,
          "kcmp invalid type EINVAL");
  require(sys_kcmp(self, self, KCMP_FILE, 9999UL, (unsigned long)pfd[0]) ==
                  -1 &&
              errno == EBADF,
          "kcmp invalid fd EBADF");

  require(close(epfd) == 0, "close epfd");
  require(close(dup_rd) == 0, "close dup_rd");
  require(close(pfd[0]) == 0, "close pfd[0]");
  require(close(pfd[1]) == 0, "close pfd[1]");

  printf("kcmp-runtime: ok pid=%d diff=%d\n", (int)self, diff);
  return 0;
}
