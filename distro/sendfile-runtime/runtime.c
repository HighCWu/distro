#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int read_exact(int fd, uint8_t *buf, size_t len, const char *label) {
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
  const char *src_path = "/tmp/sendfile-src.dat";
  const char *dst_path = "/tmp/sendfile-dst.dat";
  uint8_t src_buf[16384], rx_buf[16384];
  int src_fd, dst_fd, pfd[2], sv[2];
  off_t off;
  ssize_t n;

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");

  for (size_t i = 0; i < sizeof(src_buf); ++i)
    src_buf[i] = (uint8_t)((i * 131U + 17U) & 0xffU);

  src_fd = open(src_path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (src_fd < 0)
    return fail_errno("open(src)");
  if (write(src_fd, src_buf, sizeof(src_buf)) != (ssize_t)sizeof(src_buf))
    return fail_errno("write(src)");
  if (lseek(src_fd, 0, SEEK_SET) != 0)
    return fail_errno("lseek(src, 0)");

  dst_fd = open(dst_path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (dst_fd < 0)
    return fail_errno("open(dst)");

  /* 1. File -> File with explicit offset (must not move src_fd cursor). */
  off = 4096;
  n = sendfile(dst_fd, src_fd, &off, 8192);
  if (n != 8192 || off != 12288) {
    fprintf(stderr, "FAIL: sendfile(file->file, off) n=%zd off=%lld\n",
            n, (long long)off);
    return 1;
  }
  if (lseek(src_fd, 0, SEEK_CUR) != 0) {
    fprintf(stderr, "FAIL: explicit-offset sendfile moved src_fd cursor\n");
    return 1;
  }
  if (pread(dst_fd, rx_buf, 8192, 0) != 8192 ||
      memcmp(rx_buf, src_buf + 4096, 8192) != 0) {
    fprintf(stderr, "FAIL: file->file payload mismatch\n");
    return 1;
  }

  /* 2. File -> File with NULL offset (must advance src_fd cursor). */
  if (lseek(dst_fd, 0, SEEK_SET) != 0)
    return fail_errno("lseek(dst, 0)");
  n = sendfile(dst_fd, src_fd, NULL, 4096);
  if (n != 4096 || lseek(src_fd, 0, SEEK_CUR) != 4096) {
    fprintf(stderr, "FAIL: NULL-offset sendfile n=%zd\n", n);
    return 1;
  }

  /* 3. File -> Pipe full 16 KiB transfer. */
  if (pipe2(pfd, O_CLOEXEC) != 0)
    return fail_errno("pipe2");
  off = 0;
  n = sendfile(pfd[1], src_fd, &off, sizeof(src_buf));
  if (n != (ssize_t)sizeof(src_buf) || off != (off_t)sizeof(src_buf)) {
    fprintf(stderr, "FAIL: sendfile(file->pipe) n=%zd off=%lld\n",
            n, (long long)off);
    return 1;
  }
  if (close(pfd[1]) != 0)
    return fail_errno("close(pfd[1])");
  memset(rx_buf, 0, sizeof(rx_buf));
  if (read_exact(pfd[0], rx_buf, sizeof(src_buf), "read(pipe)") != 0)
    return 1;
  if (memcmp(rx_buf, src_buf, sizeof(src_buf)) != 0) {
    fprintf(stderr, "FAIL: file->pipe payload mismatch\n");
    return 1;
  }

  /* 4. File -> AF_UNIX SOCK_STREAM socketpair transfer. */
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
    return fail_errno("socketpair");
  off = 2048;
  n = sendfile(sv[0], src_fd, &off, 4096);
  if (n != 4096 || off != 6144) {
    fprintf(stderr, "FAIL: sendfile(file->sock) n=%zd off=%lld\n",
            n, (long long)off);
    return 1;
  }
  memset(rx_buf, 0, 4096);
  if (read_exact(sv[1], rx_buf, 4096, "read(sock)") != 0)
    return 1;
  if (memcmp(rx_buf, src_buf + 2048, 4096) != 0) {
    fprintf(stderr, "FAIL: file->sock payload mismatch\n");
    return 1;
  }

  /* 5. Boundary checks. */
  off = -1;
  errno = 0;
  if (sendfile(dst_fd, src_fd, &off, 64) != -1 || errno != EINVAL) {
    fprintf(stderr, "FAIL: sendfile(off=-1) expected EINVAL, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sendfile(-1, src_fd, NULL, 64) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: sendfile(out=-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sendfile(dst_fd, -1, NULL, 64) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: sendfile(in=-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }
  errno = 0;
  if (sendfile(dst_fd, pfd[0], NULL, 64) != -1 ||
      (errno != EINVAL && errno != ESPIPE)) {
    fprintf(stderr, "FAIL: sendfile(in=pipe) errno=%d\n", errno);
    return 1;
  }

  if (close(pfd[0]) != 0 || close(sv[0]) != 0 || close(sv[1]) != 0 ||
      close(dst_fd) != 0 || close(src_fd) != 0)
    return fail_errno("close(cleanup)");
  if (unlink(dst_path) != 0 || unlink(src_path) != 0)
    return fail_errno("unlink");

  printf("sendfile-runtime: PASS\n");
  return 0;
}
