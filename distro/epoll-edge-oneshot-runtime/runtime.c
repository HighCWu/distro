#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "epoll-edge-oneshot-runtime: %s (errno=%d: %s)\n", what,
          errno, strerror(errno));
  exit(1);
}

int main(void) {
  int epfd = epoll_create1(EPOLL_CLOEXEC);
  require(epfd >= 0, "epoll_create1");

  int p1[2];
  require(pipe2(p1, O_NONBLOCK | O_CLOEXEC) == 0, "pipe2 p1");

  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLET;
  ev.data.fd = p1[0];
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, p1[0], &ev) == 0, "add p1 EPOLLET");

  require(write(p1[1], "12345678", 8) == 8, "write 8 to p1");
  struct epoll_event out;
  require(epoll_wait(epfd, &out, 1, 2000) == 1 && out.data.fd == p1[0] &&
              (out.events & EPOLLIN) != 0,
          "EPOLLET first fire");

  char buf[16];
  require(read(p1[0], buf, 4) == 4 && memcmp(buf, "1234", 4) == 0,
          "partial read 4");
  require(epoll_wait(epfd, &out, 1, 0) == 0, "EPOLLET suppressed after 4B");

  require(write(p1[1], "abcd", 4) == 4, "write 4 more to p1");
  require(epoll_wait(epfd, &out, 1, 2000) == 1 && out.data.fd == p1[0],
          "EPOLLET re-triggered");
  require(read(p1[0], buf, sizeof(buf)) == 8 &&
              memcmp(buf, "5678abcd", 8) == 0,
          "drain remaining 8B");
  require(read(p1[0], buf, sizeof(buf)) == -1 && errno == EAGAIN,
          "p1 empty EAGAIN");
  require(epoll_ctl(epfd, EPOLL_CTL_DEL, p1[0], NULL) == 0, "del p1");

  int p2[2];
  require(pipe2(p2, O_NONBLOCK | O_CLOEXEC) == 0, "pipe2 p2");
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLONESHOT;
  ev.data.fd = p2[0];
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, p2[0], &ev) == 0,
          "add p2 EPOLLONESHOT");

  require(write(p2[1], "one1", 4) == 4, "write one1 to p2");
  require(epoll_wait(epfd, &out, 1, 2000) == 1 && out.data.fd == p2[0],
          "EPOLLONESHOT first fire");
  require(read(p2[0], buf, 4) == 4 && memcmp(buf, "one1", 4) == 0,
          "read one1");

  require(write(p2[1], "two2", 4) == 4, "write two2 to p2");
  require(epoll_wait(epfd, &out, 1, 0) == 0, "EPOLLONESHOT disarmed");

  require(epoll_ctl(epfd, EPOLL_CTL_MOD, p2[0], &ev) == 0,
          "EPOLL_CTL_MOD rearm p2");
  require(epoll_wait(epfd, &out, 1, 2000) == 1 && out.data.fd == p2[0],
          "EPOLLONESHOT rearmed fire");
  require(read(p2[0], buf, 4) == 4 && memcmp(buf, "two2", 4) == 0,
          "read two2");
  require(epoll_ctl(epfd, EPOLL_CTL_DEL, p2[0], NULL) == 0, "del p2");

  int sv[2];
  require(socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0,
                     sv) == 0,
          "socketpair");
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLRDHUP;
  ev.data.fd = sv[0];
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, sv[0], &ev) == 0,
          "add sv[0] EPOLLRDHUP");
  require(shutdown(sv[1], SHUT_WR) == 0, "shutdown(sv[1], SHUT_WR)");
  require(epoll_wait(epfd, &out, 1, 2000) == 1 && out.data.fd == sv[0] &&
              (out.events & EPOLLRDHUP) != 0,
          "epoll_wait EPOLLRDHUP");
  require(epoll_ctl(epfd, EPOLL_CTL_DEL, sv[0], NULL) == 0, "del sv[0]");

  sigset_t orig_mask, blk_mask, after_mask;
  require(sigprocmask(SIG_SETMASK, NULL, &orig_mask) == 0, "get orig mask");
  require(sigdelset(&orig_mask, SIGUSR1) == 0 || 1, "ensure SIGUSR1 unblocked");
  require(sigprocmask(SIG_SETMASK, &orig_mask, NULL) == 0,
          "unblock SIGUSR1 before epoll_pwait");

  blk_mask = orig_mask;
  require(sigaddset(&blk_mask, SIGUSR1) == 0, "sigaddset(SIGUSR1)");
  require(epoll_pwait(epfd, &out, 1, 0, &blk_mask) == 0,
          "epoll_pwait timeout=0");
  require(sigprocmask(SIG_SETMASK, NULL, &after_mask) == 0, "get after mask");
  require(sigismember(&after_mask, SIGUSR1) == 0,
          "epoll_pwait restored SIGUSR1 unblocked");

  require(close(sv[0]) == 0, "close sv[0]");
  require(close(sv[1]) == 0, "close sv[1]");
  require(close(p2[0]) == 0, "close p2[0]");
  require(close(p2[1]) == 0, "close p2[1]");
  require(close(p1[0]) == 0, "close p1[0]");
  require(close(p1[1]) == 0, "close p1[1]");
  require(close(epfd) == 0, "close epfd");

  printf("epoll-edge-oneshot-runtime: ok et=1 oneshot=1 rdhup=1 pwait=1\n");
  return 0;
}
