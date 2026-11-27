#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/signalfd.h>
#include <sys/timerfd.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "timerfd-signalfd-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

int main(void) {
  int epfd = epoll_create1(EPOLL_CLOEXEC);
  require(epfd >= 0, "epoll_create1");

  int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
  require(tfd >= 0, "timerfd_create");

  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN;
  ev.data.fd = tfd;
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev) == 0, "epoll_ctl add tfd");

  struct itimerspec its;
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = 15000000L;
  require(timerfd_settime(tfd, 0, &its, NULL) == 0, "timerfd_settime arm");

  struct itimerspec cur;
  require(timerfd_gettime(tfd, &cur) == 0, "timerfd_gettime armed");

  struct epoll_event out_ev;
  int nev;
  do {
    nev = epoll_wait(epfd, &out_ev, 1, 2000);
  } while (nev < 0 && errno == EINTR);
  require(nev == 1 && out_ev.data.fd == tfd && (out_ev.events & EPOLLIN) != 0,
          "epoll_wait timerfd");

  uint64_t exp_cnt = 0;
  require(read(tfd, &exp_cnt, sizeof(exp_cnt)) == (ssize_t)sizeof(exp_cnt),
          "read timerfd");
  require(exp_cnt >= 1ULL, "timerfd expirations >= 1");
  require(read(tfd, &exp_cnt, sizeof(exp_cnt)) == -1 && errno == EAGAIN,
          "read timerfd EAGAIN");

  memset(&its, 0, sizeof(its));
  require(timerfd_settime(tfd, 0, &its, NULL) == 0, "timerfd_settime disarm");
  require(timerfd_gettime(tfd, &cur) == 0, "timerfd_gettime disarmed");
  require(cur.it_value.tv_sec == 0 && cur.it_value.tv_nsec == 0,
          "timerfd disarmed zero");
  require(epoll_ctl(epfd, EPOLL_CTL_DEL, tfd, NULL) == 0, "epoll_ctl del tfd");

  sigset_t mask;
  require(sigemptyset(&mask) == 0, "sigemptyset");
  require(sigaddset(&mask, SIGUSR1) == 0, "sigaddset(SIGUSR1)");
  require(sigaddset(&mask, SIGRTMIN + 1) == 0, "sigaddset(SIGRTMIN+1)");
  require(sigprocmask(SIG_BLOCK, &mask, NULL) == 0, "sigprocmask(SIG_BLOCK)");

  sigset_t m1;
  require(sigemptyset(&m1) == 0, "sigemptyset m1");
  require(sigaddset(&m1, SIGUSR1) == 0, "sigaddset m1");
  int sfd = signalfd(-1, &m1, SFD_NONBLOCK | SFD_CLOEXEC);
  require(sfd >= 0, "signalfd create");

  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN;
  ev.data.fd = sfd;
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev) == 0, "epoll_ctl add sfd");

  require(kill(getpid(), SIGUSR1) == 0, "kill(SIGUSR1)");
  do {
    nev = epoll_wait(epfd, &out_ev, 1, 2000);
  } while (nev < 0 && errno == EINTR);
  require(nev == 1 && out_ev.data.fd == sfd && (out_ev.events & EPOLLIN) != 0,
          "epoll_wait signalfd SIGUSR1");

  struct signalfd_siginfo fdsi;
  require(read(sfd, &fdsi, sizeof(fdsi)) == (ssize_t)sizeof(fdsi),
          "read signalfd SIGUSR1");
  require(fdsi.ssi_signo == (uint32_t)SIGUSR1 &&
              fdsi.ssi_pid == (uint32_t)getpid(),
          "signalfd SIGUSR1 fields");

  require(signalfd(sfd, &mask, 0) == sfd, "signalfd update mask");
  union sigval sv;
  sv.sival_int = 0x13572468;
  require(sigqueue(getpid(), SIGRTMIN + 1, sv) == 0, "sigqueue(SIGRTMIN+1)");

  do {
    nev = epoll_wait(epfd, &out_ev, 1, 2000);
  } while (nev < 0 && errno == EINTR);
  require(nev == 1 && out_ev.data.fd == sfd && (out_ev.events & EPOLLIN) != 0,
          "epoll_wait signalfd SIGRTMIN+1");

  require(read(sfd, &fdsi, sizeof(fdsi)) == (ssize_t)sizeof(fdsi),
          "read signalfd SIGRTMIN+1");
  require(fdsi.ssi_signo == (uint32_t)(SIGRTMIN + 1) &&
              fdsi.ssi_int == 0x13572468,
          "signalfd SIGRTMIN+1 payload");
  require(read(sfd, &fdsi, sizeof(fdsi)) == -1 && errno == EAGAIN,
          "read signalfd EAGAIN");

  require(close(sfd) == 0, "close sfd");
  require(close(tfd) == 0, "close tfd");
  require(close(epfd) == 0, "close epfd");

  printf("timerfd-signalfd-runtime: ok exp=%llu rtval=0x%x\n",
         (unsigned long long)exp_cnt, fdsi.ssi_int);
  return 0;
}
