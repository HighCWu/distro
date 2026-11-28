#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <unistd.h>

#define TMPFS_MAGIC_VAL 0x01021994UL
#define RAMFS_MAGIC_VAL 0x858458f6UL

static int fail_errno(const char *msg) {
  fprintf(stderr, "FAIL: %s: %s (errno=%d)\n", msg, strerror(errno), errno);
  return 1;
}

static int test_root_fs(void) {
  struct statfs sfs;
  struct statvfs svfs;
  unsigned long ftype;

  if (statfs("/", &sfs) != 0)
    return fail_errno("statfs(/)");
  if (statvfs("/", &svfs) != 0)
    return fail_errno("statvfs(/)");

  ftype = (unsigned long)sfs.f_type;
  if (ftype != RAMFS_MAGIC_VAL && ftype != TMPFS_MAGIC_VAL) {
    fprintf(stderr, "FAIL: unexpected root f_type=0x%lx\n", ftype);
    return 1;
  }
  if (sfs.f_bsize <= 0 || sfs.f_namelen <= 0 ||
      svfs.f_bsize == 0 || svfs.f_frsize == 0 || svfs.f_namemax == 0) {
    fprintf(stderr, "FAIL: invalid root statfs/statvfs fields\n");
    return 1;
  }

  printf("root_fs: ok (type=0x%lx bsize=%ld namelen=%ld)\n",
         ftype, (long)sfs.f_bsize, (long)sfs.f_namelen);
  return 0;
}

static int test_tmpfs_and_fd(void) {
  const char *path = "/tmp/statfs-probe.dat";
  struct statfs sfs_before, sfs_after, fsfs;
  struct statvfs svfs_before, fsvfs;
  char page[4096];
  int fd;

  if (statfs("/tmp", &sfs_before) != 0)
    return fail_errno("statfs(/tmp)");
  if (statvfs("/tmp", &svfs_before) != 0)
    return fail_errno("statvfs(/tmp)");

  if ((unsigned long)sfs_before.f_type != TMPFS_MAGIC_VAL) {
    fprintf(stderr, "FAIL: /tmp f_type=0x%lx, expected TMPFS_MAGIC\n",
            (unsigned long)sfs_before.f_type);
    return 1;
  }
  if (sfs_before.f_bsize <= 0 || sfs_before.f_namelen <= 0 ||
      svfs_before.f_bsize == 0 || svfs_before.f_frsize == 0 ||
      svfs_before.f_namemax == 0) {
    fprintf(stderr, "FAIL: invalid /tmp statfs/statvfs fields\n");
    return 1;
  }

  fd = open(path, O_CREAT | O_RDWR | O_TRUNC | O_CLOEXEC, 0644);
  if (fd < 0)
    return fail_errno("open(/tmp/statfs-probe.dat)");

  memset(page, 'S', sizeof(page));
  if (write(fd, page, sizeof(page)) != (ssize_t)sizeof(page))
    return fail_errno("write(page)");

  if (fstatfs(fd, &fsfs) != 0)
    return fail_errno("fstatfs");
  if (fstatvfs(fd, &fsvfs) != 0)
    return fail_errno("fstatvfs");

  if (fsfs.f_type != sfs_before.f_type ||
      fsfs.f_bsize != sfs_before.f_bsize ||
      fsfs.f_namelen != sfs_before.f_namelen ||
      fsvfs.f_fsid != svfs_before.f_fsid ||
      fsvfs.f_namemax != svfs_before.f_namemax) {
    fprintf(stderr, "FAIL: fstatfs/fstatvfs mismatch vs /tmp\n");
    return 1;
  }

  if (statfs("/tmp", &sfs_after) != 0)
    return fail_errno("statfs(/tmp after)");
  if (sfs_before.f_files > 0 && sfs_after.f_ffree > sfs_before.f_ffree) {
    fprintf(stderr, "FAIL: f_ffree increased after file create\n");
    return 1;
  }

  if (close(fd) != 0)
    return fail_errno("close");
  if (unlink(path) != 0)
    return fail_errno("unlink");

  printf("tmpfs_fd: ok (bsize=%lu frsize=%lu namemax=%lu)\n",
         svfs_before.f_bsize, svfs_before.f_frsize, svfs_before.f_namemax);
  return 0;
}

static int test_error_bounds(void) {
  struct statfs sfs;
  struct statvfs svfs;
  const char *volatile null_path = NULL;

  errno = 0;
  if (fstatfs(-1, &sfs) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: fstatfs(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (fstatvfs(-1, &svfs) != -1 || errno != EBADF) {
    fprintf(stderr, "FAIL: fstatvfs(-1) expected EBADF, errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (statfs("/tmp/no-such-statfs-entry", &sfs) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: statfs(ENOENT) errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (statvfs("/tmp/no-such-statfs-entry", &svfs) != -1 || errno != ENOENT) {
    fprintf(stderr, "FAIL: statvfs(ENOENT) errno=%d\n", errno);
    return 1;
  }

  errno = 0;
  if (statfs(null_path, &sfs) != -1 || errno != EFAULT) {
    fprintf(stderr, "FAIL: statfs(NULL) expected EFAULT, errno=%d\n", errno);
    return 1;
  }

  printf("error_bounds: ok (EBADF/ENOENT/EFAULT)\n");
  return 0;
}

int main(void) {
  if (test_root_fs() != 0)
    return 1;
  if (test_tmpfs_and_fd() != 0)
    return 1;
  if (test_error_bounds() != 0)
    return 1;
  printf("statfs-fstatfs-statvfs-runtime: PASS\n");
  return 0;
}
