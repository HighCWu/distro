#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "eventfd-semaphore-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void *wakeup_worker(void *arg) {
  int efd = *(int *)arg;
  uint64_t inc = 7ULL;
  require(write(efd, &inc, sizeof(inc)) == (ssize_t)sizeof(inc),
          "worker write(efd)");
  return NULL;
}

int main(void) {
  require(eventfd(0U, 0x10000) == -1 && errno == EINVAL,
          "eventfd invalid flags EINVAL");

  int efd = eventfd(0U, EFD_NONBLOCK | EFD_CLOEXEC);
  require(efd >= 0, "eventfd(EFD_NONBLOCK)");

  uint64_t v1 = 5ULL;
  uint64_t v2 = 3ULL;
  uint64_t got = 0ULL;
  require(write(efd, &v1, sizeof(v1)) == (ssize_t)sizeof(v1), "write 5");
  require(write(efd, &v2, sizeof(v2)) == (ssize_t)sizeof(v2), "write 3");
  require(read(efd, &got, sizeof(got)) == (ssize_t)sizeof(got) && got == 8ULL,
          "read accumulated 8");
  require(read(efd, &got, sizeof(got)) == -1 && errno == EAGAIN,
          "read empty EAGAIN");

  int sfd = eventfd(0U, EFD_SEMAPHORE | EFD_NONBLOCK | EFD_CLOEXEC);
  require(sfd >= 0, "eventfd(EFD_SEMAPHORE)");

  uint64_t tokens = 3ULL;
  require(write(sfd, &tokens, sizeof(tokens)) == (ssize_t)sizeof(tokens),
          "write 3 semaphore tokens");
  for (int i = 0; i < 3; i++) {
    got = 0ULL;
    require(read(sfd, &got, sizeof(got)) == (ssize_t)sizeof(got) && got == 1ULL,
            "semaphore read == 1");
  }
  require(read(sfd, &got, sizeof(got)) == -1 && errno == EAGAIN,
          "semaphore empty EAGAIN");

  int epfd = epoll_create1(EPOLL_CLOEXEC);
  require(epfd >= 0, "epoll_create1");
  struct epoll_event ev;
  memset(&ev, 0, sizeof(ev));
  ev.events = EPOLLIN | EPOLLET;
  ev.data.fd = sfd;
  require(epoll_ctl(epfd, EPOLL_CTL_ADD, sfd, &ev) == 0, "epoll_ctl add sfd");

  uint64_t two = 2ULL;
  require(write(sfd, &two, sizeof(two)) == (ssize_t)sizeof(two), "write 2");
  struct epoll_event out_ev;
  int nev = epoll_wait(epfd, &out_ev, 1, 2000);
  require(nev == 1 && out_ev.data.fd == sfd && (out_ev.events & EPOLLIN) != 0,
          "epoll_wait sfd");
  require(read(sfd, &got, sizeof(got)) == (ssize_t)sizeof(got) && got == 1ULL,
          "sem drain 1");
  require(read(sfd, &got, sizeof(got)) == (ssize_t)sizeof(got) && got == 1ULL,
          "sem drain 2");
  require(epoll_wait(epfd, &out_ev, 1, 0) == 0, "epoll_wait empty == 0");

  int bfd = eventfd(0U, EFD_CLOEXEC);
  require(bfd >= 0, "blocking eventfd");
  pthread_t tid;
  require(pthread_create(&tid, NULL, wakeup_worker, &bfd) == 0,
          "pthread_create");
  got = 0ULL;
  require(read(bfd, &got, sizeof(got)) == (ssize_t)sizeof(got) && got == 7ULL,
          "blocking read from worker == 7");
  require(pthread_join(tid, NULL) == 0, "pthread_join");

  require(close(bfd) == 0, "close bfd");
  require(close(epfd) == 0, "close epfd");
  require(close(sfd) == 0, "close sfd");
  require(close(efd) == 0, "close efd");

  printf("eventfd-semaphore-runtime: ok sem=3 epoll=1 mt=7\n");
  return 0;
}
