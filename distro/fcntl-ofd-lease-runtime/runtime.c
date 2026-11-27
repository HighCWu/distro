#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "fcntl-ofd-lease-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

int main(void) {
  int fd1 = open("/tmp/ofd.dat", O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  require(fd1 >= 0, "open(/tmp/ofd.dat fd1)");
  require(write(fd1, "ofd-lock-data", 13) == 13, "write ofd.dat");

  int fd2 = open("/tmp/ofd.dat", O_RDWR | O_CLOEXEC);
  require(fd2 >= 0, "open(/tmp/ofd.dat fd2)");

  struct flock lk;
  memset(&lk, 0, sizeof(lk));
  lk.l_type = F_WRLCK;
  lk.l_whence = SEEK_SET;
  lk.l_start = 0;
  lk.l_len = 64;
  lk.l_pid = 0;
  require(fcntl(fd1, F_OFD_SETLK, &lk) == 0, "F_OFD_SETLK fd1");

  struct flock glk;
  memset(&glk, 0, sizeof(glk));
  glk.l_type = F_WRLCK;
  glk.l_whence = SEEK_SET;
  glk.l_start = 0;
  glk.l_len = 64;
  glk.l_pid = 0;
  require(fcntl(fd2, F_OFD_GETLK, &glk) == 0, "F_OFD_GETLK fd2");
  require(glk.l_type == F_WRLCK && glk.l_pid == -1,
          "F_OFD_GETLK l_type=F_WRLCK l_pid=-1");

  memset(&lk, 0, sizeof(lk));
  lk.l_type = F_WRLCK;
  lk.l_whence = SEEK_SET;
  lk.l_start = 0;
  lk.l_len = 64;
  lk.l_pid = 0;
  require(fcntl(fd2, F_OFD_SETLK, &lk) == -1 &&
              (errno == EAGAIN || errno == EWOULDBLOCK),
          "F_OFD_SETLK fd2 conflict");

  require(close(fd1) == 0, "close fd1");
  memset(&lk, 0, sizeof(lk));
  lk.l_type = F_WRLCK;
  lk.l_whence = SEEK_SET;
  lk.l_start = 0;
  lk.l_len = 64;
  lk.l_pid = 0;
  require(fcntl(fd2, F_OFD_SETLK, &lk) == 0, "F_OFD_SETLK fd2 after close");
  require(close(fd2) == 0, "close fd2");
  require(unlink("/tmp/ofd.dat") == 0, "unlink ofd.dat");

  int fl1 =
      open("/tmp/flock.dat", O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  int fl2 = open("/tmp/flock.dat", O_RDWR | O_CLOEXEC);
  require(fl1 >= 0 && fl2 >= 0, "open flock.dat");
  require(flock(fl1, LOCK_EX | LOCK_NB) == 0, "flock fl1 LOCK_EX");
  require(flock(fl2, LOCK_EX | LOCK_NB) == -1 &&
              (errno == EWOULDBLOCK || errno == EAGAIN),
          "flock fl2 conflict");
  require(flock(fl1, LOCK_UN) == 0, "flock fl1 LOCK_UN");
  require(flock(fl2, LOCK_EX | LOCK_NB) == 0, "flock fl2 after unlock");
  require(close(fl1) == 0, "close fl1");
  require(close(fl2) == 0, "close fl2");
  require(unlink("/tmp/flock.dat") == 0, "unlink flock.dat");

  int lfd =
      open("/tmp/lease.dat", O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  require(lfd >= 0, "open lease.dat");
  require(fcntl(lfd, F_SETLEASE, F_WRLCK) == 0, "F_SETLEASE(F_WRLCK)");
  require(fcntl(lfd, F_GETLEASE) == F_WRLCK, "F_GETLEASE == F_WRLCK");
  require(fcntl(lfd, F_SETLEASE, F_UNLCK) == 0, "F_SETLEASE(F_UNLCK)");
  require(fcntl(lfd, F_GETLEASE) == F_UNLCK, "F_GETLEASE == F_UNLCK");

  int dup_fd = fcntl(lfd, F_DUPFD_CLOEXEC, 10);
  require(dup_fd >= 10, "F_DUPFD_CLOEXEC");
  int fd_flags = fcntl(dup_fd, F_GETFD);
  require(fd_flags >= 0 && (fd_flags & FD_CLOEXEC) != 0,
          "FD_CLOEXEC on dup_fd");

  int fl = fcntl(dup_fd, F_GETFL);
  require(fl >= 0, "F_GETFL");
  require(fcntl(dup_fd, F_SETFL, fl | O_NONBLOCK) == 0, "F_SETFL +O_NONBLOCK");
  int fl_nb = fcntl(dup_fd, F_GETFL);
  require(fl_nb >= 0 && (fl_nb & O_NONBLOCK) != 0, "O_NONBLOCK set");
  require(fcntl(dup_fd, F_SETFL, fl & ~O_NONBLOCK) == 0,
          "F_SETFL -O_NONBLOCK");
  int fl_clr = fcntl(dup_fd, F_GETFL);
  require(fl_clr >= 0 && (fl_clr & O_NONBLOCK) == 0, "O_NONBLOCK cleared");

  require(close(dup_fd) == 0, "close dup_fd");
  require(close(lfd) == 0, "close lfd");
  require(unlink("/tmp/lease.dat") == 0, "unlink lease.dat");

  printf("fcntl-ofd-lease-runtime: ok ofd=1 flock=1 lease=1 dup=%d\n", dup_fd);
  return 0;
}
