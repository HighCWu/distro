#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/statfs.h>
#include <unistd.h>

#define EXT2_SUPER_MAGIC_VAL 0xEF53UL
#define RW_TEST_BYTES 32768U

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "ext2-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void write_all(int fd, const uint8_t *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      require(0, "write");
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
      require(0, "read");
    }
    require(n > 0, "unexpected EOF");
    off += (size_t)n;
  }
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext2", 0, NULL) == 0,
          "mount(/dev/vda, ext2)");

  struct statfs sfs;
  require(statfs("/mnt", &sfs) == 0, "statfs(/mnt)");
  require((unsigned long)sfs.f_type == EXT2_SUPER_MAGIC_VAL,
          "EXT2_SUPER_MAGIC");

  int seed_fd = open("/mnt/seed.txt", O_RDONLY | O_CLOEXEC);
  require(seed_fd >= 0, "open(/mnt/seed.txt)");
  const char expected_seed[] = "ext2-seed-v1\n";
  char seed_buf[32];
  memset(seed_buf, 0, sizeof(seed_buf));
  ssize_t sn = read(seed_fd, seed_buf, sizeof(seed_buf) - 1);
  require(sn == (ssize_t)(sizeof(expected_seed) - 1), "read(/mnt/seed.txt)");
  require(memcmp(seed_buf, expected_seed, sizeof(expected_seed) - 1) == 0,
          "seed.txt content");
  require(close(seed_fd) == 0, "close(/mnt/seed.txt)");

  uint8_t *wbuf = malloc(RW_TEST_BYTES);
  uint8_t *rbuf = malloc(RW_TEST_BYTES);
  require(wbuf != NULL && rbuf != NULL, "malloc");
  for (size_t i = 0; i < RW_TEST_BYTES; i++) {
    wbuf[i] = (uint8_t)((i * 97U + 31U) & 0xffU);
  }

  int rw_fd = open("/mnt/ext2_rw.bin", O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC,
                   0644);
  require(rw_fd >= 0, "open(/mnt/ext2_rw.bin write)");
  write_all(rw_fd, wbuf, RW_TEST_BYTES);
  require(fsync(rw_fd) == 0, "fsync(/mnt/ext2_rw.bin)");
  require(close(rw_fd) == 0, "close(/mnt/ext2_rw.bin write)");

  rw_fd = open("/mnt/ext2_rw.bin", O_RDONLY | O_CLOEXEC);
  require(rw_fd >= 0, "open(/mnt/ext2_rw.bin read)");
  read_all_exact(rw_fd, rbuf, RW_TEST_BYTES);
  require(close(rw_fd) == 0, "close(/mnt/ext2_rw.bin read)");
  require(memcmp(wbuf, rbuf, RW_TEST_BYTES) == 0, "ext2_rw.bin readback");
  free(wbuf);
  free(rbuf);

  require(unlink("/mnt/ext2_rw.bin") == 0, "unlink(/mnt/ext2_rw.bin)");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("ext2-runtime: ok magic=0x%lx bytes=%u\n", (unsigned long)sfs.f_type,
         RW_TEST_BYTES);
  return 0;
}
