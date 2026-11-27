#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

# Run nfs_valid_ioctl (which exercises FIXTURE_SETUP's 11x unshare(CLONE_NEWNS)
# + open(/proc/self/ns/mnt) + NS_MNT_GET_INFO ioctl, plus AUTOFS_DEV_IOCTL_*
# ENOTTY rejection on nsfs). The other tests in iterate_mntns.c either call
# 2-arg variadic fcntl(F_DUPFD_CLOEXEC) or double-close fd_mnt_ns[0].
out=$(iterate_mntns -t nfs_valid_ioctl 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "iterate_mntns -t nfs_valid_ioctl failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "iterate_mntns -t nfs_valid_ioctl reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
