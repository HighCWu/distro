#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int read_exact(int fd, char *buf, size_t len, const char *label) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = read(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      return fail_errno(label);
    }
    if (n == 0) {
      fprintf(stderr, "FAIL: %s unexpected EOF at %zu/%zu\n", label, off, len);
      return 1;
    }
    off += (size_t)n;
  }
  return 0;
}

static int test_posix_openpt_termios_winsize(void) {
  int master, slave;
  const char *pts;
  struct winsize ws, ws_got;
  struct termios orig_tio, raw_tio, check_tio;
  const char m2s[] = "pty-m2s\n";
  const char s2m[] = "pty-s2m\n";
  char buf[32];

  master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (master < 0)
    return fail_errno("posix_openpt");
  if (grantpt(master) != 0)
    return fail_errno("grantpt");
  if (unlockpt(master) != 0)
    return fail_errno("unlockpt");

  pts = ptsname(master);
  if (!pts || strncmp(pts, "/dev/pts/", 9) != 0) {
    fprintf(stderr, "FAIL: unexpected ptsname '%s'\n", pts ? pts : "(null)");
    return 1;
  }

  slave = open(pts, O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (slave < 0)
    return fail_errno("open(pts)");

  memset(&ws, 0, sizeof(ws));
  ws.ws_row = 42;
  ws.ws_col = 132;
  ws.ws_xpixel = 1056;
  ws.ws_ypixel = 672;
  if (ioctl(master, TIOCSWINSZ, &ws) != 0)
    return fail_errno("ioctl(TIOCSWINSZ)");

  memset(&ws_got, 0, sizeof(ws_got));
  if (ioctl(slave, TIOCGWINSZ, &ws_got) != 0)
    return fail_errno("ioctl(TIOCGWINSZ)");
  if (ws_got.ws_row != 42 || ws_got.ws_col != 132 ||
      ws_got.ws_xpixel != 1056 || ws_got.ws_ypixel != 672) {
    fprintf(stderr, "FAIL: TIOCGWINSZ got %ux%u (%ux%u)\n",
            ws_got.ws_row, ws_got.ws_col, ws_got.ws_xpixel, ws_got.ws_ypixel);
    return 1;
  }

  if (tcgetattr(slave, &orig_tio) != 0)
    return fail_errno("tcgetattr(orig)");

  raw_tio = orig_tio;
  cfmakeraw(&raw_tio);
  raw_tio.c_cc[VMIN] = 1;
  raw_tio.c_cc[VTIME] = 0;
  if (tcsetattr(slave, TCSANOW, &raw_tio) != 0)
    return fail_errno("tcsetattr(raw)");

  if (tcgetattr(slave, &check_tio) != 0)
    return fail_errno("tcgetattr(check)");
  if ((check_tio.c_lflag & (ICANON | ECHO | ISIG)) != 0 ||
      (check_tio.c_iflag & (IXON | ICRNL)) != 0 ||
      (check_tio.c_oflag & OPOST) != 0) {
    fprintf(stderr, "FAIL: cfmakeraw flags not applied l=0x%lx i=0x%lx o=0x%lx\n",
            (unsigned long)check_tio.c_lflag,
            (unsigned long)check_tio.c_iflag,
            (unsigned long)check_tio.c_oflag);
    return 1;
  }

  if (write(master, m2s, sizeof(m2s) - 1) != (ssize_t)(sizeof(m2s) - 1))
    return fail_errno("write(master)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(slave, buf, sizeof(m2s) - 1, "read(slave)") != 0)
    return 1;
  if (memcmp(buf, m2s, sizeof(m2s) - 1) != 0) {
    fprintf(stderr, "FAIL: master->slave loopback mismatch\n");
    return 1;
  }

  if (write(slave, s2m, sizeof(s2m) - 1) != (ssize_t)(sizeof(s2m) - 1))
    return fail_errno("write(slave)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(master, buf, sizeof(s2m) - 1, "read(master)") != 0)
    return 1;
  if (memcmp(buf, s2m, sizeof(s2m) - 1) != 0) {
    fprintf(stderr, "FAIL: slave->master loopback mismatch\n");
    return 1;
  }

  if (close(slave) != 0 || close(master) != 0)
    return fail_errno("close(pty)");

  printf("posix_openpt_termios_winsize: ok (pts=%s %ux%u)\n",
         pts, ws_got.ws_row, ws_got.ws_col);
  return 0;
}

static int test_openpty(void) {
  int master = -1, slave = -1;
  char name[64];
  struct winsize ws, ws_got;
  struct termios tio;
  const char msg[] = "openpty";
  char buf[16];

  memset(&ws, 0, sizeof(ws));
  ws.ws_row = 24;
  ws.ws_col = 80;
  memset(name, 0, sizeof(name));
  if (openpty(&master, &slave, name, NULL, &ws) != 0)
    return fail_errno("openpty");

  if (name[0] == '\0') {
    fprintf(stderr, "FAIL: openpty returned empty name\n");
    return 1;
  }

  memset(&ws_got, 0, sizeof(ws_got));
  if (ioctl(slave, TIOCGWINSZ, &ws_got) != 0)
    return fail_errno("ioctl(openpty TIOCGWINSZ)");
  if (ws_got.ws_row != 24 || ws_got.ws_col != 80) {
    fprintf(stderr, "FAIL: openpty winsize got %ux%u\n",
            ws_got.ws_row, ws_got.ws_col);
    return 1;
  }

  if (tcgetattr(slave, &tio) != 0)
    return fail_errno("tcgetattr(openpty)");
  cfmakeraw(&tio);
  if (tcsetattr(slave, TCSANOW, &tio) != 0)
    return fail_errno("tcsetattr(openpty)");

  if (write(master, msg, sizeof(msg) - 1) != (ssize_t)(sizeof(msg) - 1))
    return fail_errno("write(openpty master)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(slave, buf, sizeof(msg) - 1, "read(openpty slave)") != 0)
    return 1;
  if (memcmp(buf, msg, sizeof(msg) - 1) != 0) {
    fprintf(stderr, "FAIL: openpty loopback mismatch\n");
    return 1;
  }

  if (close(slave) != 0 || close(master) != 0)
    return fail_errno("close(openpty)");

  printf("openpty: ok (name=%s %ux%u)\n", name, ws_got.ws_row, ws_got.ws_col);
  return 0;
}

int main(void) {
  if (test_posix_openpt_termios_winsize() != 0)
    return 1;
  if (test_openpty() != 0)
    return 1;
  printf("ioctl-pty-termios-winsize-runtime: PASS\n");
  return 0;
}
