#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int test_eventfd_semaphore(void) {
  int efd;
  uint64_t val = 3, got = 0;

  efd = eventfd(0, EFD_SEMAPHORE | EFD_NONBLOCK | EFD_CLOEXEC);
  if (efd < 0)
    return fail_errno("eventfd(EFD_SEMAPHORE)");

  if (write(efd, &val, sizeof(val)) != (ssize_t)sizeof(val))
    return fail_errno("write(eventfd)");

  for (int i = 0; i < 3; ++i) {
    got = 0;
    if (read(efd, &got, sizeof(got)) != (ssize_t)sizeof(got) || got != 1) {
      fprintf(stderr, "FAIL: eventfd semaphore read[%d] got=%llu\n",
              i, (unsigned long long)got);
      return 1;
    }
  }

  errno = 0;
  if (read(efd, &got, sizeof(got)) != -1 ||
      (errno != EAGAIN && errno != EWOULDBLOCK)) {
    fprintf(stderr, "FAIL: eventfd empty read errno=%d\n", errno);
    return 1;
  }

  if (close(efd) != 0)
    return fail_errno("close(efd)");

  printf("eventfd_semaphore: ok\n");
  return 0;
}

static int test_signalfd_and_epoll(void) {
  sigset_t mask, orig;
  int sfd, epfd, efd, pfd[2], sv[2];
  struct epoll_event ev, out_ev;
  struct signalfd_siginfo fdsi;
  uint64_t one = 1, got = 0;
  int seen_usr1 = 0, seen_rt = 0;
  char buf[16];
  union sigval sv_rt;

  epfd = epoll_create1(EPOLL_CLOEXEC);
  if (epfd < 0)
    return fail_errno("epoll_create1");

  /* 1. signalfd4 with blocked SIGUSR1 + SIGRTMIN monitored via epoll. */
  sigemptyset(&mask);
  sigaddset(&mask, SIGUSR1);
  sigaddset(&mask, SIGRTMIN);
  if (sigprocmask(SIG_BLOCK, &mask, &orig) != 0)
    return fail_errno("sigprocmask(SIG_BLOCK)");

  sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
  if (sfd < 0)
    return fail_errno("signalfd");

  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN;
  ev.data.fd = sfd;
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev) != 0)
    return fail_errno("epoll_ctl(ADD sfd)");

  if (raise(SIGUSR1) != 0)
    return fail_errno("raise(SIGUSR1)");
  sv_rt.sival_int = 77;
  if (sigqueue(getpid(), SIGRTMIN, sv_rt) != 0)
    return fail_errno("sigqueue(SIGRTMIN)");

  if (epoll_wait(epfd, &out_ev, 1, 100) != 1 || out_ev.data.fd != sfd)
    return fail_errno("epoll_wait(signalfd)");

  for (int i = 0; i < 2; ++i) {
    if (read(sfd, &fdsi, sizeof(fdsi)) != (ssize_t)sizeof(fdsi))
      return fail_errno("read(signalfd)");
    if (fdsi.ssi_signo == (uint32_t)SIGUSR1) {
      seen_usr1 = 1;
    } else if (fdsi.ssi_signo == (uint32_t)SIGRTMIN && fdsi.ssi_int == 77) {
      seen_rt = 1;
    }
  }
  if (!seen_usr1 || !seen_rt) {
    fprintf(stderr, "FAIL: signalfd usr1=%d rt=%d\n", seen_usr1, seen_rt);
    return 1;
  }

  /* 2. EPOLLET on pipe2. */
  if (pipe2(pfd, O_NONBLOCK | O_CLOEXEC) != 0)
    return fail_errno("pipe2");
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLET;
  ev.data.fd = pfd[0];
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, pfd[0], &ev) != 0)
    return fail_errno("epoll_ctl(ADD pipe)");

  if (write(pfd[1], "edge-msg", 8) != 8)
    return fail_errno("write(pipe)");
  if (epoll_wait(epfd, &out_ev, 1, 100) != 1 || out_ev.data.fd != pfd[0])
    return fail_errno("epoll_wait(EPOLLET 1)");
  /* Without draining, EPOLLET must not re-fire immediately. */
  if (epoll_wait(epfd, &out_ev, 1, 0) != 0) {
    fprintf(stderr, "FAIL: EPOLLET re-fired without new edge\n");
    return 1;
  }
  if (read(pfd[0], buf, 8) != 8)
    return fail_errno("read(pipe)");

  /* 3. EPOLLONESHOT + EPOLL_CTL_MOD re-arm on eventfd. */
  efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (efd < 0)
    return fail_errno("eventfd(oneshot)");
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLONESHOT;
  ev.data.fd = efd;
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, efd, &ev) != 0)
    return fail_errno("epoll_ctl(ADD oneshot)");

  if (write(efd, &one, sizeof(one)) != (ssize_t)sizeof(one))
    return fail_errno("write(efd oneshot)");
  if (epoll_wait(epfd, &out_ev, 1, 100) != 1 || out_ev.data.fd != efd)
    return fail_errno("epoll_wait(oneshot 1)");
  if (epoll_wait(epfd, &out_ev, 1, 0) != 0) {
    fprintf(stderr, "FAIL: EPOLLONESHOT fired twice before re-arm\n");
    return 1;
  }
  if (epoll_ctl(epfd, EPOLL_CTL_MOD, efd, &ev) != 0)
    return fail_errno("epoll_ctl(MOD re-arm)");
  if (epoll_wait(epfd, &out_ev, 1, 100) != 1 || out_ev.data.fd != efd)
    return fail_errno("epoll_wait(oneshot re-arm)");
  if (read(efd, &got, sizeof(got)) != (ssize_t)sizeof(got))
    return fail_errno("read(efd oneshot)");

  /* 4. EPOLLRDHUP on AF_UNIX SOCK_STREAM peer shutdown(SHUT_WR). */
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0, sv) != 0)
    return fail_errno("socketpair");
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLRDHUP;
  ev.data.fd = sv[0];
  if (epoll_ctl(epfd, EPOLL_CTL_ADD, sv[0], &ev) != 0)
    return fail_errno("epoll_ctl(ADD sv[0])");

  if (shutdown(sv[1], SHUT_WR) != 0)
    return fail_errno("shutdown(sv[1], SHUT_WR)");
  if (epoll_wait(epfd, &out_ev, 1, 100) != 1 || out_ev.data.fd != sv[0] ||
      (out_ev.events & EPOLLRDHUP) == 0) {
    fprintf(stderr, "FAIL: expected EPOLLRDHUP on sv[0], events=0x%x\n",
            out_ev.events);
    return 1;
  }

  if (close(sv[0]) != 0 || close(sv[1]) != 0 || close(efd) != 0 ||
      close(pfd[0]) != 0 || close(pfd[1]) != 0 || close(sfd) != 0 ||
      close(epfd) != 0)
    return fail_errno("close(cleanup)");
  if (sigprocmask(SIG_SETMASK, &orig, NULL) != 0)
    return fail_errno("sigprocmask(restore)");

  printf("signalfd_epoll: ok\n");
  return 0;
}

int main(void) {
  if (test_eventfd_semaphore() != 0)
    return 1;
  if (test_signalfd_and_epoll() != 0)
    return 1;
  printf("eventfd-signalfd-epoll-runtime: PASS\n");
  return 0;
}
