#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "time-ns-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void read_link_str(const char *path, char *buf, size_t len) {
  ssize_t n = readlink(path, buf, len - 1);
  require(n > 0, path);
  buf[n] = '\0';
}

int main(void) {
  struct timespec t0_mono, t0_boot;
  require(clock_gettime(CLOCK_MONOTONIC, &t0_mono) == 0,
          "clock_gettime(MONOTONIC) baseline");
  require(clock_gettime(CLOCK_BOOTTIME, &t0_boot) == 0,
          "clock_gettime(BOOTTIME) baseline");

  char ns_t0[128], ns_c0[128];
  read_link_str("/proc/self/ns/time", ns_t0, sizeof(ns_t0));
  read_link_str("/proc/self/ns/time_for_children", ns_c0, sizeof(ns_c0));
  require(strcmp(ns_t0, ns_c0) == 0, "initial time == time_for_children");

  require(unshare(CLONE_NEWTIME) == 0, "unshare(CLONE_NEWTIME)");

  char ns_t1[128], ns_c1[128];
  read_link_str("/proc/self/ns/time", ns_t1, sizeof(ns_t1));
  read_link_str("/proc/self/ns/time_for_children", ns_c1, sizeof(ns_c1));
  require(strcmp(ns_t1, ns_t0) == 0, "time ns unchanged after unshare");
  require(strcmp(ns_c1, ns_t1) != 0,
          "time_for_children changed after unshare");

  int off_fd = open("/proc/self/timens_offsets", O_WRONLY | O_CLOEXEC);
  require(off_fd >= 0, "open(/proc/self/timens_offsets write)");
  const char offsets[] = "monotonic 120 0\nboottime 240 0\n";
  require(write(off_fd, offsets, sizeof(offsets) - 1) ==
              (ssize_t)(sizeof(offsets) - 1),
          "write(/proc/self/timens_offsets)");
  require(close(off_fd) == 0, "close(timens_offsets write)");

  int bad_fd = open("/proc/self/timens_offsets", O_WRONLY | O_CLOEXEC);
  require(bad_fd >= 0, "open(/proc/self/timens_offsets invalid)");
  const char bad_off[] = "realtime 10 0\n";
  ssize_t bad_ret = write(bad_fd, bad_off, sizeof(bad_off) - 1);
  require(bad_ret < 0 && errno == EINVAL,
          "invalid clockid in timens_offsets returns EINVAL");
  require(close(bad_fd) == 0, "close(timens_offsets invalid)");

  int r_fd = open("/proc/self/timens_offsets", O_RDONLY | O_CLOEXEC);
  require(r_fd >= 0, "open(/proc/self/timens_offsets read)");
  char rbuf[256];
  ssize_t rn = read(r_fd, rbuf, sizeof(rbuf) - 1);
  require(rn > 0, "read(/proc/self/timens_offsets)");
  rbuf[rn] = '\0';
  require(close(r_fd) == 0, "close(timens_offsets read)");
  require(strstr(rbuf, "monotonic") != NULL && strstr(rbuf, "120") != NULL &&
              strstr(rbuf, "boottime") != NULL && strstr(rbuf, "240") != NULL,
          "timens_offsets readback");

  int ns_fd = open("/proc/self/ns/time_for_children", O_RDONLY | O_CLOEXEC);
  require(ns_fd >= 0, "open(/proc/self/ns/time_for_children)");
  require(setns(ns_fd, CLONE_NEWTIME) == 0, "setns(CLONE_NEWTIME)");
  require(close(ns_fd) == 0, "close(ns_fd)");

  char ns_t2[128], ns_c2[128];
  read_link_str("/proc/self/ns/time", ns_t2, sizeof(ns_t2));
  read_link_str("/proc/self/ns/time_for_children", ns_c2, sizeof(ns_c2));
  require(strcmp(ns_t2, ns_c1) == 0 && strcmp(ns_t2, ns_c2) == 0,
          "time == time_for_children after setns");

  struct timespec t1_mono, t1_boot;
  require(clock_gettime(CLOCK_MONOTONIC, &t1_mono) == 0,
          "clock_gettime(MONOTONIC) after setns");
  require(clock_gettime(CLOCK_BOOTTIME, &t1_boot) == 0,
          "clock_gettime(BOOTTIME) after setns");

  long long d_mono = (long long)(t1_mono.tv_sec - t0_mono.tv_sec);
  long long d_boot = (long long)(t1_boot.tv_sec - t0_boot.tv_sec);
  require(d_mono >= 100, "monotonic offset >= 100s");
  require(d_boot >= 220, "boottime offset >= 220s");

  printf("time-ns-runtime: ok d_mono=%llds d_boot=%llds\n", d_mono, d_boot);
  return 0;
}
