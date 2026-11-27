#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/select.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int verify_sigusr1_blocked(const char *where) {
  sigset_t cur;
  if (sigprocmask(SIG_SETMASK, NULL, &cur) != 0)
    return fail_errno("sigprocmask(query)");
  if (!sigismember(&cur, SIGUSR1)) {
    fprintf(stderr, "FAIL: SIGUSR1 not restored in sigmask after %s\n", where);
    return 1;
  }
  return 0;
}

static int test_pipe_select_poll_hup(void) {
  int fds[2];
  fd_set rfds, wfds;
  struct timeval tv;
  struct pollfd pfds[2];
  char buf[16];
  int rc;

  if (pipe2(fds, O_NONBLOCK | O_CLOEXEC) != 0)
    return fail_errno("pipe2");

  FD_ZERO(&rfds);
  FD_ZERO(&wfds);
  FD_SET(fds[0], &rfds);
  FD_SET(fds[1], &wfds);
  tv.tv_sec = 0;
  tv.tv_usec = 0;
  rc = select(fds[1] + 1, &rfds, &wfds, NULL, &tv);
  if (rc != 1 || FD_ISSET(fds[0], &rfds) || !FD_ISSET(fds[1], &wfds)) {
    fprintf(stderr, "FAIL: initial select rc=%d r=%d w=%d\n", rc,
            FD_ISSET(fds[0], &rfds), FD_ISSET(fds[1], &wfds));
    return 1;
  }

  if (write(fds[1], "ping", 4) != 4)
    return fail_errno("write(pipe)");

  pfds[0].fd = fds[0];
  pfds[0].events = POLLIN;
  pfds[0].revents = 0;
  pfds[1].fd = fds[1];
  pfds[1].events = POLLOUT;
  pfds[1].revents = 0;
  rc = poll(pfds, 2, 0);
  if (rc != 2 || (pfds[0].revents & POLLIN) == 0 ||
      (pfds[1].revents & POLLOUT) == 0) {
    fprintf(stderr, "FAIL: poll after write rc=%d r=0x%x w=0x%x\n", rc,
            pfds[0].revents, pfds[1].revents);
    return 1;
  }

  if (read(fds[0], buf, sizeof(buf)) != 4 || memcmp(buf, "ping", 4) != 0)
    return fail_errno("read(pipe)");

  if (close(fds[1]) != 0)
    return fail_errno("close(pipe write)");

  pfds[0].fd = fds[0];
  pfds[0].events = POLLIN;
  pfds[0].revents = 0;
  rc = poll(pfds, 1, 0);
  if (rc != 1 || (pfds[0].revents & POLLHUP) == 0) {
    fprintf(stderr, "FAIL: poll after close(write) rc=%d revents=0x%x\n",
            rc, pfds[0].revents);
    return 1;
  }

  FD_ZERO(&rfds);
  FD_SET(fds[0], &rfds);
  tv.tv_sec = 0;
  tv.tv_usec = 0;
  rc = select(fds[0] + 1, &rfds, NULL, NULL, &tv);
  if (rc != 1 || !FD_ISSET(fds[0], &rfds)) {
    fprintf(stderr, "FAIL: select after close(write) rc=%d\n", rc);
    return 1;
  }

  if (close(fds[0]) != 0)
    return fail_errno("close(pipe read)");

  printf("pipe_select_poll_hup: ok\n");
  return 0;
}

static int test_eventfd_timerfd_pselect_ppoll(void) {
  int efd, tfd, rc;
  uint64_t val = 1, exp = 0;
  struct itimerspec its;
  struct timespec ts;
  fd_set rfds;
  struct pollfd pfd;
  sigset_t orig_mask, block_mask, empty_mask;

  sigemptyset(&block_mask);
  sigaddset(&block_mask, SIGUSR1);
  sigemptyset(&empty_mask);
  if (sigprocmask(SIG_BLOCK, &block_mask, &orig_mask) != 0)
    return fail_errno("sigprocmask(SIG_BLOCK)");

  efd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (efd < 0)
    return fail_errno("eventfd");

  tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
  if (tfd < 0)
    return fail_errno("timerfd_create");

  /* Verify pselect6 timeout and sigmask restore when nothing is ready. */
  FD_ZERO(&rfds);
  FD_SET(efd, &rfds);
  ts.tv_sec = 0;
  ts.tv_nsec = 1000000L;
  rc = pselect(efd + 1, &rfds, NULL, NULL, &ts, &empty_mask);
  if (rc != 0) {
    fprintf(stderr, "FAIL: pselect idle expected 0, got %d (errno=%d)\n",
            rc, errno);
    return 1;
  }
  if (verify_sigusr1_blocked("pselect(idle)") != 0)
    return 1;

  /* Signal eventfd and verify pselect6 readiness + sigmask restore. */
  if (write(efd, &val, sizeof(val)) != (ssize_t)sizeof(val))
    return fail_errno("write(eventfd)");

  FD_ZERO(&rfds);
  FD_SET(efd, &rfds);
  ts.tv_sec = 0;
  ts.tv_nsec = 50000000L;
  rc = pselect(efd + 1, &rfds, NULL, NULL, &ts, &empty_mask);
  if (rc != 1 || !FD_ISSET(efd, &rfds)) {
    fprintf(stderr, "FAIL: pselect(eventfd) rc=%d ready=%d\n",
            rc, FD_ISSET(efd, &rfds));
    return 1;
  }
  if (verify_sigusr1_blocked("pselect(eventfd)") != 0)
    return 1;

  if (read(efd, &val, sizeof(val)) != (ssize_t)sizeof(val) || val != 1)
    return fail_errno("read(eventfd)");

  /* Arm short timerfd (10ms) and wait via ppoll + sigmask restore. */
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = 10000000L;
  if (timerfd_settime(tfd, 0, &its, NULL) != 0)
    return fail_errno("timerfd_settime");

  pfd.fd = tfd;
  pfd.events = POLLIN;
  pfd.revents = 0;
  ts.tv_sec = 1;
  ts.tv_nsec = 0;
  rc = ppoll(&pfd, 1, &ts, &empty_mask);
  if (rc != 1 || (pfd.revents & POLLIN) == 0) {
    fprintf(stderr, "FAIL: ppoll(timerfd) rc=%d revents=0x%x\n",
            rc, pfd.revents);
    return 1;
  }
  if (verify_sigusr1_blocked("ppoll(timerfd)") != 0)
    return 1;

  if (read(tfd, &exp, sizeof(exp)) != (ssize_t)sizeof(exp) || exp < 1) {
    fprintf(stderr, "FAIL: read(timerfd) exp=%llu\n",
            (unsigned long long)exp);
    return 1;
  }

  if (sigprocmask(SIG_SETMASK, &orig_mask, NULL) != 0)
    return fail_errno("sigprocmask(restore)");
  if (close(tfd) != 0 || close(efd) != 0)
    return fail_errno("close(efd/tfd)");

  printf("eventfd_timerfd_pselect_ppoll: ok (exp=%llu)\n",
         (unsigned long long)exp);
  return 0;
}

int main(void) {
  if (test_pipe_select_poll_hup() != 0)
    return 1;
  if (test_eventfd_timerfd_pselect_ppoll() != 0)
    return 1;
  printf("select-pselect-poll-ppoll-runtime: PASS\n");
  return 0;
}
