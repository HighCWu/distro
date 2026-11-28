#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int sys_mlock(const void *addr, size_t len) {
  return (int)syscall(SYS_mlock, addr, (unsigned long)len);
}

static int sys_munlock(const void *addr, size_t len) {
  return (int)syscall(SYS_munlock, addr, (unsigned long)len);
}

static int sys_mprotect(void *addr, size_t len, int prot) {
  return (int)syscall(SYS_mprotect, addr, (unsigned long)len,
                      (unsigned long)prot);
}

static int test_anon_madvise_mlock_mprotect(size_t pagesz) {
  size_t len = pagesz * 2U;
  uint8_t *anon = mmap(NULL, len, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (anon == MAP_FAILED)
    return fail_errno("mmap(anon)");

  memset(anon, 0x5a, len);

  if (madvise(anon, len, MADV_SEQUENTIAL) != 0)
    return fail_errno("madvise(MADV_SEQUENTIAL)");
  if (madvise(anon, len, MADV_WILLNEED) != 0)
    return fail_errno("madvise(MADV_WILLNEED)");

  if (sys_mlock(anon, len) != 0) {
    if (errno != ENOSYS)
      return fail_errno("mlock(anon)");
  } else if (sys_munlock(anon, len) != 0) {
    return fail_errno("munlock(anon)");
  }

  if (sys_mprotect(anon, len, PROT_READ) != 0) {
    if (errno != ENOSYS)
      return fail_errno("mprotect(PROT_READ)");
  } else {
    if (anon[0] != 0x5a || anon[len - 1] != 0x5a) {
      fprintf(stderr, "FAIL: anon contents corrupted across mprotect\n");
      return 1;
    }
    if (sys_mprotect(anon, len, PROT_READ | PROT_WRITE) != 0)
      return fail_errno("mprotect(PROT_READ|PROT_WRITE)");
    anon[0] = 0xa5;
    anon[len - 1] = 0xa5;

    errno = 0;
    if (sys_mprotect(anon + 1, pagesz, PROT_READ) != -1 || errno != EINVAL) {
      fprintf(stderr, "FAIL: unaligned mprotect expected EINVAL, errno=%d\n",
              errno);
      return 1;
    }
  }

  if (madvise(anon, len, MADV_DONTNEED) != 0)
    return fail_errno("madvise(MADV_DONTNEED)");

  if (munmap(anon, len) != 0)
    return fail_errno("munmap(anon)");

  printf("anon_madvise_mlock_mprotect: ok (len=%zu)\n", len);
  return 0;
}

static int test_file_msync(size_t pagesz) {
  const char *path = "/tmp/madvise_msync_test.dat";
  size_t len = pagesz * 2U;
  int fd;
  void *shared;
  uint8_t *map;
  char check[16];

  if (mkdir("/tmp", 0755) != 0 && errno != EEXIST)
    return fail_errno("mkdir(/tmp)");

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(file)");
  if (ftruncate(fd, (off_t)len) != 0)
    return fail_errno("ftruncate");
  if (pwrite(fd, "MSYNC_PAYLOAD!", 14, 0) != 14)
    return fail_errno("pwrite(page1)");
  if (pwrite(fd, "PAGE2_OK", 8, (off_t)pagesz) != 8)
    return fail_errno("pwrite(page2)");

  shared = mmap(NULL, len, PROT_READ, MAP_SHARED, fd, 0);
  if (shared != MAP_FAILED) {
    if (munmap(shared, len) != 0)
      return fail_errno("munmap(shared)");
  } else if (errno != EINVAL && errno != ENODEV && errno != EOPNOTSUPP) {
    return fail_errno("mmap(file MAP_SHARED)");
  }

  map = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
  if (map == MAP_FAILED)
    return fail_errno("mmap(file)");

  if (memcmp(map, "MSYNC_PAYLOAD!", 14) != 0 ||
      memcmp(map + pagesz, "PAGE2_OK", 8) != 0) {
    fprintf(stderr, "FAIL: MAP_PRIVATE initial contents mismatch\n");
    return 1;
  }

  if (madvise(map, len, MADV_WILLNEED) != 0 && errno != ENOSYS)
    return fail_errno("madvise(file WILLNEED)");
  if (madvise(map, len, MADV_SEQUENTIAL) != 0 && errno != ENOSYS)
    return fail_errno("madvise(file SEQUENTIAL)");

  map[0] = 'X';
  memset(check, 0, sizeof(check));
  if (pread(fd, check, 14, 0) != 14 ||
      memcmp(check, "MSYNC_PAYLOAD!", 14) != 0) {
    fprintf(stderr, "FAIL: MAP_PRIVATE write leaked to backing file\n");
    return 1;
  }

  if (msync(map, len, MS_SYNC) != 0) {
    if (errno != ENOSYS)
      return fail_errno("msync(MS_SYNC)");
  } else {
    errno = 0;
    if (msync(map, len, MS_SYNC | MS_ASYNC) != -1 || errno != EINVAL) {
      fprintf(stderr, "FAIL: msync(MS_SYNC|MS_ASYNC) expected EINVAL, errno=%d\n",
              errno);
      return 1;
    }
  }

  if (sys_mlock(map, pagesz) != 0) {
    if (errno != ENOSYS)
      return fail_errno("mlock(file)");
  } else if (sys_munlock(map, pagesz) != 0) {
    return fail_errno("munlock(file)");
  }

  if (munmap(map, len) != 0)
    return fail_errno("munmap(file)");
  if (close(fd) != 0)
    return fail_errno("close(file)");
  if (unlink(path) != 0)
    return fail_errno("unlink(file)");

  printf("file_msync: ok (pagesz=%zu)\n", pagesz);
  return 0;
}

int main(void) {
  long ps = sysconf(_SC_PAGESIZE);
  size_t pagesz = (ps > 0) ? (size_t)ps : 4096U;

  if (test_anon_madvise_mlock_mprotect(pagesz) != 0)
    return 1;
  if (test_file_msync(pagesz) != 0)
    return 1;

  printf("madvise-msync-mlock-runtime: PASS\n");
  return 0;
}
