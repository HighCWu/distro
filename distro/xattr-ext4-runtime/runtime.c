#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

#define EXT4_SUPER_MAGIC_VAL 0xEF53UL

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "xattr-ext4-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static int list_contains(const char *buf, ssize_t len, const char *target) {
  size_t pos = 0;
  while (pos < (size_t)len) {
    const char *name = buf + pos;
    if (strcmp(name, target) == 0) {
      return 1;
    }
    pos += strlen(name) + 1;
  }
  return 0;
}

int main(void) {
  require(mount("/dev/vda", "/mnt", "ext4", 0, NULL) == 0,
          "mount(/dev/vda, ext4)");

  struct statfs sfs;
  require(statfs("/mnt", &sfs) == 0, "statfs(/mnt)");
  require((unsigned long)sfs.f_type == EXT4_SUPER_MAGIC_VAL,
          "EXT4_SUPER_MAGIC");

  const char *path = "/mnt/xattr.dat";
  int fd = open(path, O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0644);
  require(fd >= 0, "open(/mnt/xattr.dat)");

  const char val1[] = "hello-xattr";
  require(setxattr(path, "user.wasm.text", val1, sizeof(val1) - 1,
                   XATTR_CREATE) == 0,
          "setxattr XATTR_CREATE");
  require(setxattr(path, "user.wasm.text", val1, sizeof(val1) - 1,
                   XATTR_CREATE) == -1 &&
              errno == EEXIST,
          "setxattr XATTR_CREATE EEXIST");
  require(setxattr(path, "user.wasm.missing", val1, sizeof(val1) - 1,
                   XATTR_REPLACE) == -1 &&
              errno == ENODATA,
          "setxattr XATTR_REPLACE ENODATA");

  char rbuf[64];
  ssize_t rn = getxattr(path, "user.wasm.text", rbuf, sizeof(rbuf));
  require(rn == (ssize_t)(sizeof(val1) - 1) &&
              memcmp(rbuf, val1, sizeof(val1) - 1) == 0,
          "getxattr user.wasm.text");

  char lbuf[256];
  ssize_t ln = listxattr(path, lbuf, sizeof(lbuf));
  require(ln > 0 && list_contains(lbuf, ln, "user.wasm.text"),
          "listxattr user.wasm.text");

  const uint8_t bin_val[] = {0x00, 0x41, 0x00, 0x7f, 0xff, 0x00, 0x42};
  require(fsetxattr(fd, "user.wasm.bin", bin_val, sizeof(bin_val), 0) == 0,
          "fsetxattr binary");
  uint8_t bin_out[32];
  rn = fgetxattr(fd, "user.wasm.bin", bin_out, sizeof(bin_out));
  require(rn == (ssize_t)sizeof(bin_val) &&
              memcmp(bin_out, bin_val, sizeof(bin_val)) == 0,
          "fgetxattr binary with NULs");

  ln = flistxattr(fd, lbuf, sizeof(lbuf));
  require(ln > 0 && list_contains(lbuf, ln, "user.wasm.bin"),
          "flistxattr user.wasm.bin");

  const char *sym = "/mnt/xattr.sym";
  require(symlink(path, sym) == 0, "symlink");
  rn = lgetxattr(sym, "user.wasm.text", rbuf, sizeof(rbuf));
  require(rn == -1 && errno == ENODATA,
          "lgetxattr on symlink ENODATA (no deref)");

  require(removexattr(path, "user.wasm.text") == 0, "removexattr");
  require(getxattr(path, "user.wasm.text", rbuf, sizeof(rbuf)) == -1 &&
              errno == ENODATA,
          "getxattr after removexattr ENODATA");
  require(fremovexattr(fd, "user.wasm.bin") == 0, "fremovexattr");
  require(fgetxattr(fd, "user.wasm.bin", bin_out, sizeof(bin_out)) == -1 &&
              errno == ENODATA,
          "fgetxattr after fremovexattr ENODATA");

  require(close(fd) == 0, "close fd");
  require(unlink(sym) == 0, "unlink symlink");
  require(unlink(path) == 0, "unlink xattr.dat");
  require(umount("/mnt") == 0, "umount(/mnt)");

  printf("xattr-ext4-runtime: ok magic=0x%lx bin_len=%zu\n",
         (unsigned long)sfs.f_type, sizeof(bin_val));
  return 0;
}
