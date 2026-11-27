#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <unistd.h>

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "binfmt-misc-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void write_str(const char *path, const char *s) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  require(fd >= 0, path);
  size_t len = strlen(s);
  ssize_t n = write(fd, s, len);
  require(n == (ssize_t)len, path);
  require(close(fd) == 0, path);
}

static void read_str(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  require(fd >= 0, path);
  ssize_t n = read(fd, buf, cap - 1);
  require(n > 0, path);
  buf[n] = '\0';
  require(close(fd) == 0, path);
}

int main(void) {
  const char *mnt = "/proc/sys/fs/binfmt_misc";
  const char *entry = "/proc/sys/fs/binfmt_misc/wasm-test-fmt";

  require(mount("binfmt_misc", mnt, "binfmt_misc", 0, NULL) == 0,
          "mount(binfmt_misc)");

  char buf[512];
  read_str("/proc/sys/fs/binfmt_misc/status", buf, sizeof(buf));
  require(strstr(buf, "enabled") != NULL, "binfmt_misc status enabled");

  write_str("/proc/sys/fs/binfmt_misc/register",
            ":wasm-test-fmt:M::\\x7fWSM::/bin/true:");

  read_str(entry, buf, sizeof(buf));
  require(strstr(buf, "enabled") != NULL, "entry enabled");
  require(strstr(buf, "interpreter /bin/true") != NULL, "entry interpreter");
  require(strstr(buf, "magic 7f57534d") != NULL, "entry magic");

  write_str(entry, "0");
  read_str(entry, buf, sizeof(buf));
  require(strstr(buf, "disabled") != NULL, "entry disabled");

  write_str(entry, "-1");
  int gone = open(entry, O_RDONLY | O_CLOEXEC);
  require(gone == -1 && errno == ENOENT, "entry unregistered ENOENT");

  require(umount(mnt) == 0, "umount(binfmt_misc)");
  printf("binfmt-misc-runtime: ok registered+toggled+unregistered\n");
  return 0;
}
