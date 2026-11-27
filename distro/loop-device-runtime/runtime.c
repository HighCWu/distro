#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/loop.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/statfs.h>
#include <time.h>
#include <unistd.h>

#define EXT4_SUPER_MAGIC_VAL 0xEF53UL
#define RW_TEST_BYTES 32768U

static void die(const char *msg) {
  fprintf(stderr, "loop-device-runtime: %s: errno=%d (%s)\n", msg, errno,
          strerror(errno));
  exit(1);
}

static int open_loop_dev_wait(const char *path) {
  for (int attempt = 0; attempt < 50; attempt++) {
    int fd = open(path, O_RDWR | O_CLOEXEC);
    if (fd >= 0) {
      return fd;
    }
    if (errno != ENOENT) {
      die("open(/dev/loopN)");
    }
    struct timespec ts = {.tv_sec = 0, .tv_nsec = 10000000L};
    nanosleep(&ts, NULL);
  }
  die("open(/dev/loopN) timeout");
  return -1;
}

static void write_all(int fd, const uint8_t *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      die("write");
    }
    off += (size_t)n;
  }
}

static void read_all_exact(int fd, uint8_t *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = read(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      die("read");
    }
    if (n == 0) {
      fprintf(stderr, "loop-device-runtime: unexpected EOF at %zu/%zu\n", off,
              len);
      exit(1);
    }
    off += (size_t)n;
  }
}

int main(int argc, char **argv) {
  const char *img_path = (argc > 1 && argv[1][0] != '\0') ? argv[1] : "/tmp/loop.img";

  int ctl_fd = open("/dev/loop-control", O_RDWR | O_CLOEXEC);
  if (ctl_fd < 0) {
    die("open(/dev/loop-control)");
  }

  int idx = ioctl(ctl_fd, LOOP_CTL_GET_FREE);
  if (idx < 0) {
    die("LOOP_CTL_GET_FREE");
  }

  char loop_path[64];
  snprintf(loop_path, sizeof(loop_path), "/dev/loop%d", idx);

  int loop_fd = open_loop_dev_wait(loop_path);
  int img_fd = open(img_path, O_RDWR | O_CLOEXEC);
  if (img_fd < 0) {
    die("open(backing image)");
  }

  if (ioctl(loop_fd, LOOP_SET_FD, img_fd) != 0) {
    die("LOOP_SET_FD");
  }

  struct loop_info64 info;
  memset(&info, 0, sizeof(info));
  info.lo_flags = LO_FLAGS_AUTOCLEAR;
  snprintf((char *)info.lo_file_name, LO_NAME_SIZE, "%s", "wasm-loop-test");
  if (ioctl(loop_fd, LOOP_SET_STATUS64, &info) != 0) {
    die("LOOP_SET_STATUS64");
  }

  struct loop_info64 got;
  memset(&got, 0, sizeof(got));
  if (ioctl(loop_fd, LOOP_GET_STATUS64, &got) != 0) {
    die("LOOP_GET_STATUS64");
  }
  if ((got.lo_flags & LO_FLAGS_AUTOCLEAR) == 0 ||
      strncmp((const char *)got.lo_file_name, "wasm-loop-test", LO_NAME_SIZE) !=
          0) {
    fprintf(stderr,
            "loop-device-runtime: status64 mismatch flags=0x%x name=%.*s\n",
            got.lo_flags, LO_NAME_SIZE, (const char *)got.lo_file_name);
    return 1;
  }

  if (ioctl(loop_fd, LOOP_SET_BLOCK_SIZE, 4096UL) != 0) {
    if (errno != ENOTTY && errno != EINVAL) {
      die("LOOP_SET_BLOCK_SIZE");
    }
  }

  if (mount(loop_path, "/mnt", "ext4", 0, NULL) != 0) {
    die("mount(ext4)");
  }

  struct statfs sfs;
  if (statfs("/mnt", &sfs) != 0) {
    die("statfs(/mnt)");
  }
  if ((unsigned long)sfs.f_type != EXT4_SUPER_MAGIC_VAL) {
    fprintf(stderr, "loop-device-runtime: unexpected f_type=0x%lx\n",
            (unsigned long)sfs.f_type);
    return 1;
  }

  int seed_fd = open("/mnt/seed.txt", O_RDONLY | O_CLOEXEC);
  if (seed_fd < 0) {
    die("open(/mnt/seed.txt)");
  }
  const char expected_seed[] = "loop-seed-v1\n";
  char seed_buf[32];
  memset(seed_buf, 0, sizeof(seed_buf));
  ssize_t sn = read(seed_fd, seed_buf, sizeof(seed_buf) - 1);
  if (sn < 0) {
    die("read(/mnt/seed.txt)");
  }
  close(seed_fd);
  if ((size_t)sn != sizeof(expected_seed) - 1 ||
      memcmp(seed_buf, expected_seed, sizeof(expected_seed) - 1) != 0) {
    fprintf(stderr, "loop-device-runtime: seed mismatch\n");
    return 1;
  }

  uint8_t *wbuf = malloc(RW_TEST_BYTES);
  uint8_t *rbuf = malloc(RW_TEST_BYTES);
  if (!wbuf || !rbuf) {
    die("malloc");
  }
  for (size_t i = 0; i < RW_TEST_BYTES; i++) {
    wbuf[i] = (uint8_t)((i * 131U + 17U) & 0xffU);
  }

  int rw_fd = open("/mnt/loop_rw.bin", O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC,
                   0644);
  if (rw_fd < 0) {
    die("open(/mnt/loop_rw.bin write)");
  }
  write_all(rw_fd, wbuf, RW_TEST_BYTES);
  if (fsync(rw_fd) != 0) {
    die("fsync(/mnt/loop_rw.bin)");
  }
  close(rw_fd);

  rw_fd = open("/mnt/loop_rw.bin", O_RDONLY | O_CLOEXEC);
  if (rw_fd < 0) {
    die("open(/mnt/loop_rw.bin read)");
  }
  read_all_exact(rw_fd, rbuf, RW_TEST_BYTES);
  close(rw_fd);

  if (memcmp(wbuf, rbuf, RW_TEST_BYTES) != 0) {
    fprintf(stderr, "loop-device-runtime: readback mismatch\n");
    return 1;
  }
  free(wbuf);
  free(rbuf);

  if (unlink("/mnt/loop_rw.bin") != 0) {
    die("unlink(/mnt/loop_rw.bin)");
  }
  if (umount("/mnt") != 0) {
    die("umount(/mnt)");
  }

  if (ioctl(loop_fd, LOOP_CLR_FD, 0) != 0) {
    die("LOOP_CLR_FD");
  }

  close(loop_fd);
  close(img_fd);
  close(ctl_fd);

  printf("loop-device-runtime: ok dev=%s bytes=%u magic=0x%lx\n", loop_path,
         RW_TEST_BYTES, (unsigned long)sfs.f_type);
  return 0;
}
