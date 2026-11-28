#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
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

int main(void) {
  int master, slave;
  char pts[64], buf[64];
  struct winsize ws, ws_got;
  struct termios canon_tio, raw_tio, check_tio;

  master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (master < 0)
    return fail_errno("posix_openpt");
  if (grantpt(master) != 0)
    return fail_errno("grantpt");
  if (unlockpt(master) != 0)
    return fail_errno("unlockpt");

  memset(pts, 0, sizeof(pts));
  if (ptsname_r(master, pts, sizeof(pts)) != 0 ||
      strncmp(pts, "/dev/pts/", 9) != 0) {
    fprintf(stderr, "FAIL: ptsname_r got '%s'\n", pts);
    return 1;
  }

  slave = open(pts, O_RDWR | O_NOCTTY | O_CLOEXEC);
  if (slave < 0)
    return fail_errno("open(pts)");

  /* 1. TIOCSWINSZ / TIOCGWINSZ round-trip. */
  memset(&ws, 0, sizeof(ws));
  ws.ws_row = 50;
  ws.ws_col = 120;
  ws.ws_xpixel = 960;
  ws.ws_ypixel = 800;
  if (ioctl(master, TIOCSWINSZ, &ws) != 0)
    return fail_errno("ioctl(TIOCSWINSZ)");

  memset(&ws_got, 0, sizeof(ws_got));
  if (ioctl(slave, TIOCGWINSZ, &ws_got) != 0)
    return fail_errno("ioctl(TIOCGWINSZ)");
  if (ws_got.ws_row != 50 || ws_got.ws_col != 120 ||
      ws_got.ws_xpixel != 960 || ws_got.ws_ypixel != 800) {
    fprintf(stderr, "FAIL: TIOCGWINSZ mismatch %ux%u\n",
            ws_got.ws_row, ws_got.ws_col);
    return 1;
  }

  /* 2. Canonical mode tcgetattr/tcsetattr and line-buffered I/O. */
  if (tcgetattr(slave, &canon_tio) != 0)
    return fail_errno("tcgetattr(canon)");
  canon_tio.c_lflag |= (ICANON | ECHO);
  canon_tio.c_lflag &= ~ECHOE;
  if (tcsetattr(slave, TCSANOW, &canon_tio) != 0)
    return fail_errno("tcsetattr(canon)");
  if (tcgetattr(slave, &check_tio) != 0 ||
      (check_tio.c_lflag & ICANON) == 0) {
    fprintf(stderr, "FAIL: canonical ICANON not set\n");
    return 1;
  }

  if (write(master, "canon-line\n", 11) != 11)
    return fail_errno("write(canon)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(slave, buf, 11, "read(canon slave)") != 0 ||
      memcmp(buf, "canon-line\n", 11) != 0) {
    fprintf(stderr, "FAIL: canonical read mismatch\n");
    return 1;
  }
  /* Drain echoed line from master before switching to raw mode. */
  {
    char echo_buf[32];
    if (read(master, echo_buf, sizeof(echo_buf)) <= 0)
      return fail_errno("drain echo");
  }

  /* 3. Raw mode (cfmakeraw) and bidirectional master<->slave I/O. */
  raw_tio = canon_tio;
  cfmakeraw(&raw_tio);
  raw_tio.c_cc[VMIN] = 1;
  raw_tio.c_cc[VTIME] = 0;
  if (tcsetattr(slave, TCSANOW, &raw_tio) != 0)
    return fail_errno("tcsetattr(raw)");
  if (tcgetattr(slave, &check_tio) != 0 ||
      (check_tio.c_lflag & (ICANON | ECHO | ISIG)) != 0) {
    fprintf(stderr, "FAIL: raw mode flags not cleared\n");
    return 1;
  }

  if (write(master, "raw-m2s\n", 8) != 8)
    return fail_errno("write(raw master)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(slave, buf, 8, "read(raw slave)") != 0 ||
      memcmp(buf, "raw-m2s\n", 8) != 0) {
    fprintf(stderr, "FAIL: raw m2s mismatch\n");
    return 1;
  }

  if (write(slave, "raw-s2m\n", 8) != 8)
    return fail_errno("write(raw slave)");
  memset(buf, 0, sizeof(buf));
  if (read_exact(master, buf, 8, "read(raw master)") != 0 ||
      memcmp(buf, "raw-s2m\n", 8) != 0) {
    fprintf(stderr, "FAIL: raw s2m mismatch\n");
    return 1;
  }

  if (close(slave) != 0 || close(master) != 0)
    return fail_errno("close(pty)");

  printf("pty-termios-winsize-runtime: PASS\n");
  return 0;
}
