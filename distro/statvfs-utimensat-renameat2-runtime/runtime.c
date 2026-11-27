#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "statvfs-utimensat-renameat2-runtime: %s (errno=%d: %s)\n",
          what, errno, strerror(errno));
  exit(1);
}

static void write_file_str(const char *path, const char *s) {
  int fd = open(path, O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(fd >= 0, path);
  size_t len = strlen(s);
  require(write(fd, s, len) == (ssize_t)len, path);
  require(close(fd) == 0, path);
}

static void read_file_str(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  require(fd >= 0, path);
  ssize_t n = read(fd, buf, cap - 1);
  require(n > 0, path);
  buf[n] = '\0';
  require(close(fd) == 0, path);
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext4", 0, NULL) == 0,
          "mount(/dev/vda, ext4)");

  int tfd = open("/mnt/t.txt", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(tfd >= 0, "open(/mnt/t.txt)");

  struct statvfs svfs, fsvfs;
  require(statvfs("/mnt", &svfs) == 0, "statvfs(/mnt)");
  require(fstatvfs(tfd, &fsvfs) == 0, "fstatvfs(tfd)");
  require(svfs.f_bsize > 0 && svfs.f_blocks > 0 && svfs.f_bfree > 0 &&
              (svfs.f_flag & ST_RDONLY) == 0,
          "statvfs rw ext4 fields");
  require(fsvfs.f_bsize == svfs.f_bsize && fsvfs.f_blocks == svfs.f_blocks,
          "fstatvfs == statvfs");
  require(close(tfd) == 0, "close tfd");

  struct timespec ts1[2] = {
      {.tv_sec = 1700000100, .tv_nsec = 123456789L},
      {.tv_sec = 1700000200, .tv_nsec = 987654321L},
  };
  require(utimensat(AT_FDCWD, "/mnt/t.txt", ts1, 0) == 0, "utimensat explicit");

  struct stat st;
  require(stat("/mnt/t.txt", &st) == 0, "stat explicit");
  require(st.st_atim.tv_sec == 1700000100 &&
              st.st_atim.tv_nsec == 123456789L &&
              st.st_mtim.tv_sec == 1700000200 &&
              st.st_mtim.tv_nsec == 987654321L,
          "utimensat ns match");

  struct timespec ts2[2] = {
      {.tv_sec = 0, .tv_nsec = UTIME_OMIT},
      {.tv_sec = 1700000300, .tv_nsec = 111222333L},
  };
  require(utimensat(AT_FDCWD, "/mnt/t.txt", ts2, 0) == 0,
          "utimensat UTIME_OMIT");
  require(stat("/mnt/t.txt", &st) == 0, "stat UTIME_OMIT");
  require(st.st_atim.tv_sec == 1700000100 &&
              st.st_atim.tv_nsec == 123456789L &&
              st.st_mtim.tv_sec == 1700000300 &&
              st.st_mtim.tv_nsec == 111222333L,
          "UTIME_OMIT preserved atime");

  struct timespec ts3[2] = {
      {.tv_sec = 0, .tv_nsec = UTIME_OMIT},
      {.tv_sec = 0, .tv_nsec = UTIME_NOW},
  };
  require(utimensat(AT_FDCWD, "/mnt/t.txt", ts3, 0) == 0,
          "utimensat UTIME_NOW");
  require(stat("/mnt/t.txt", &st) == 0, "stat UTIME_NOW");
  require(st.st_mtim.tv_sec != 1700000300, "UTIME_NOW updated mtime");

  write_file_str("/mnt/a.txt", "alpha-a");
  write_file_str("/mnt/b.txt", "beta-b");

  struct stat sta, stb;
  require(stat("/mnt/a.txt", &sta) == 0 && stat("/mnt/b.txt", &stb) == 0,
          "stat a/b");

  require(renameat2(AT_FDCWD, "/mnt/a.txt", AT_FDCWD, "/mnt/b.txt",
                    RENAME_NOREPLACE) == -1 &&
              errno == EEXIST,
          "RENAME_NOREPLACE EEXIST");
  require(renameat2(AT_FDCWD, "/mnt/a.txt", AT_FDCWD, "/mnt/c.txt",
                    RENAME_NOREPLACE) == 0,
          "RENAME_NOREPLACE new target");
  require(renameat2(AT_FDCWD, "/mnt/c.txt", AT_FDCWD, "/mnt/a.txt",
                    RENAME_NOREPLACE) == 0,
          "RENAME_NOREPLACE restore");

  require(renameat2(AT_FDCWD, "/mnt/a.txt", AT_FDCWD, "/mnt/b.txt",
                    RENAME_EXCHANGE) == 0,
          "RENAME_EXCHANGE");

  struct stat sta2, stb2;
  require(stat("/mnt/a.txt", &sta2) == 0 && stat("/mnt/b.txt", &stb2) == 0,
          "stat a/b after exchange");
  require(sta2.st_ino == stb.st_ino && stb2.st_ino == sta.st_ino,
          "RENAME_EXCHANGE swapped inodes");

  char ba[32], bb[32];
  read_file_str("/mnt/a.txt", ba, sizeof(ba));
  read_file_str("/mnt/b.txt", bb, sizeof(bb));
  require(strcmp(ba, "beta-b") == 0 && strcmp(bb, "alpha-a") == 0,
          "RENAME_EXCHANGE swapped contents");

  require(unlink("/mnt/t.txt") == 0, "unlink t.txt");
  require(unlink("/mnt/a.txt") == 0, "unlink a.txt");
  require(unlink("/mnt/b.txt") == 0, "unlink b.txt");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("statvfs-utimensat-renameat2-runtime: ok bsize=%lu blocks=%llu\n",
         (unsigned long)svfs.f_bsize, (unsigned long long)svfs.f_blocks);
  return 0;
}
