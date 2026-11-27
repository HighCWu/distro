#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int is_wouldblock(int err) {
  return err == EAGAIN || err == EWOULDBLOCK;
}

static int drain_fd(int fd, size_t *total_out) {
  char buf[4096];
  size_t total = 0;

  for (;;) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n > 0) {
      total += (size_t)n;
      continue;
    }
    if (n == 0) {
      fprintf(stderr, "FAIL: unexpected EOF while draining pipe\n");
      return 1;
    }
    if (is_wouldblock(errno))
      break;
    return fail_errno("read(drain)");
  }

  if (total_out)
    *total_out = total;
  return 0;
}

static int test_pipe2_fionread_poll(int fds[2]) {
  const char msg[] = "wasm-pipe2-fionread-payload";
  char rbuf[64];
  int fd_flags, fl_flags, avail = -1;
  struct pollfd pfds[2];
  ssize_t n;

  if (pipe2(fds, O_NONBLOCK | O_CLOEXEC) != 0)
    return fail_errno("pipe2");

  for (int i = 0; i < 2; ++i) {
    fd_flags = fcntl(fds[i], F_GETFD);
    if (fd_flags < 0)
      return fail_errno("fcntl(F_GETFD)");
    if ((fd_flags & FD_CLOEXEC) == 0) {
      fprintf(stderr, "FAIL: fds[%d] missing FD_CLOEXEC (flags=%d)\n",
              i, fd_flags);
      return 1;
    }

    fl_flags = fcntl(fds[i], F_GETFL);
    if (fl_flags < 0)
      return fail_errno("fcntl(F_GETFL)");
    if ((fl_flags & O_NONBLOCK) == 0) {
      fprintf(stderr, "FAIL: fds[%d] missing O_NONBLOCK (flags=%d)\n",
              i, fl_flags);
      return 1;
    }
  }

  errno = 0;
  n = read(fds[0], rbuf, sizeof(rbuf));
  if (n != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: empty read returned %zd errno=%d\n", n, errno);
    return 1;
  }

  n = write(fds[1], msg, sizeof(msg) - 1);
  if (n != (ssize_t)(sizeof(msg) - 1))
    return fail_errno("write(msg)");

  if (ioctl(fds[0], FIONREAD, &avail) != 0)
    return fail_errno("ioctl(FIONREAD)");
  if (avail != (int)(sizeof(msg) - 1)) {
    fprintf(stderr, "FAIL: FIONREAD=%d, expected %zu\n",
            avail, sizeof(msg) - 1);
    return 1;
  }

  pfds[0].fd = fds[0];
  pfds[0].events = POLLIN;
  pfds[0].revents = 0;
  pfds[1].fd = fds[1];
  pfds[1].events = POLLOUT;
  pfds[1].revents = 0;
  if (poll(pfds, 2, 0) != 2)
    return fail_errno("poll");
  if ((pfds[0].revents & POLLIN) == 0 || (pfds[1].revents & POLLOUT) == 0) {
    fprintf(stderr, "FAIL: unexpected poll revents r=0x%x w=0x%x\n",
            pfds[0].revents, pfds[1].revents);
    return 1;
  }

  memset(rbuf, 0, sizeof(rbuf));
  n = read(fds[0], rbuf, sizeof(rbuf));
  if (n != (ssize_t)(sizeof(msg) - 1) ||
      memcmp(rbuf, msg, sizeof(msg) - 1) != 0) {
    fprintf(stderr, "FAIL: read payload mismatch n=%zd\n", n);
    return 1;
  }

  if (ioctl(fds[0], FIONREAD, &avail) != 0)
    return fail_errno("ioctl(FIONREAD after drain)");
  if (avail != 0) {
    fprintf(stderr, "FAIL: FIONREAD after drain=%d, expected 0\n", avail);
    return 1;
  }

  errno = 0;
  n = read(fds[0], rbuf, sizeof(rbuf));
  if (n != -1 || !is_wouldblock(errno)) {
    fprintf(stderr, "FAIL: post-drain read returned %zd errno=%d\n", n, errno);
    return 1;
  }

  printf("pipe2_fionread_poll: ok (bytes=%zu)\n", sizeof(msg) - 1);
  return 0;
}

static int test_dup_variants(int fds[2]) {
  int d1, d2, d3, flags;
  const char tag[] = "dup-shared";
  char buf[32];
  ssize_t n;

  d1 = dup(fds[1]);
  if (d1 < 0)
    return fail_errno("dup");
  flags = fcntl(d1, F_GETFD);
  if (flags < 0)
    return fail_errno("fcntl(F_GETFD, dup)");
  if ((flags & FD_CLOEXEC) != 0) {
    fprintf(stderr, "FAIL: dup() preserved FD_CLOEXEC\n");
    return 1;
  }

  d2 = dup2(fds[0], d1 + 10);
  if (d2 < 0)
    return fail_errno("dup2");
  flags = fcntl(d2, F_GETFD);
  if (flags < 0)
    return fail_errno("fcntl(F_GETFD, dup2)");
  if ((flags & FD_CLOEXEC) != 0) {
    fprintf(stderr, "FAIL: dup2() set FD_CLOEXEC\n");
    return 1;
  }

  d3 = dup3(fds[0], d1 + 11, O_CLOEXEC);
  if (d3 < 0)
    return fail_errno("dup3");
  flags = fcntl(d3, F_GETFD);
  if (flags < 0)
    return fail_errno("fcntl(F_GETFD, dup3)");
  if ((flags & FD_CLOEXEC) == 0) {
    fprintf(stderr, "FAIL: dup3(O_CLOEXEC) missing FD_CLOEXEC\n");
    return 1;
  }

  if (write(d1, tag, 4) != 4 || write(fds[1], tag + 4, 6) != 6)
    return fail_errno("write(dup shared)");

  memset(buf, 0, sizeof(buf));
  n = read(d2, buf, 4);
  if (n != 4)
    return fail_errno("read(d2)");
  n = read(d3, buf + 4, 6);
  if (n != 6)
    return fail_errno("read(d3)");
  if (memcmp(buf, tag, 10) != 0) {
    fprintf(stderr, "FAIL: dup shared pipe data mismatch\n");
    return 1;
  }

  if (close(d1) != 0 || close(d2) != 0 || close(d3) != 0)
    return fail_errno("close(dup fds)");

  printf("dup_variants: ok (dup/dup2/dup3)\n");
  return 0;
}

static int test_pipe_sz_and_full_write(int fds[2]) {
  long pagesz = sysconf(_SC_PAGESIZE);
  int orig_sz, req_sz, new_sz, got_sz;
  char chunk[4096];
  size_t written = 0, drained = 0;

  if (pagesz <= 0)
    pagesz = 4096;

  orig_sz = fcntl(fds[1], F_GETPIPE_SZ);
  if (orig_sz <= 0)
    return fail_errno("fcntl(F_GETPIPE_SZ)");

  req_sz = (pagesz < 8192) ? 8192 : (int)pagesz;
  new_sz = fcntl(fds[1], F_SETPIPE_SZ, (unsigned long)req_sz);
  if (new_sz < 0)
    return fail_errno("fcntl(F_SETPIPE_SZ)");

  got_sz = fcntl(fds[1], F_GETPIPE_SZ);
  if (got_sz != new_sz || got_sz < req_sz) {
    fprintf(stderr, "FAIL: F_GETPIPE_SZ=%d after F_SETPIPE_SZ=%d (req=%d)\n",
            got_sz, new_sz, req_sz);
    return 1;
  }

  memset(chunk, 'P', sizeof(chunk));
  for (;;) {
    ssize_t n = write(fds[1], chunk, sizeof(chunk));
    if (n > 0) {
      written += (size_t)n;
      continue;
    }
    if (n == -1 && is_wouldblock(errno))
      break;
    return fail_errno("write(fill pipe)");
  }

  if (written == 0) {
    fprintf(stderr, "FAIL: wrote 0 bytes before EAGAIN\n");
    return 1;
  }

  if (drain_fd(fds[0], &drained) != 0)
    return 1;
  if (drained != written) {
    fprintf(stderr, "FAIL: drained %zu != written %zu\n", drained, written);
    return 1;
  }

  printf("pipe_sz_full: ok (orig=%d new=%d filled=%zu)\n",
         orig_sz, got_sz, written);
  return 0;
}

int main(void) {
  int fds[2] = { -1, -1 };

  if (test_pipe2_fionread_poll(fds) != 0)
    return 1;
  if (test_dup_variants(fds) != 0)
    return 1;
  if (test_pipe_sz_and_full_write(fds) != 0)
    return 1;
  if (close(fds[0]) != 0 || close(fds[1]) != 0)
    return fail_errno("close(pipe)");

  printf("dup-pipe-nonblock-fionread-runtime: PASS\n");
  return 0;
}
