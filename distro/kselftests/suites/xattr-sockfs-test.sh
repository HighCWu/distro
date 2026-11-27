#!/bin/busybox sh

# Runs all 14 TAP cases in tools/testing/selftests/filesystems/xattr/xattr_sockfs_test
# (compiled with -DKSELFTEST_HARNESS_NO_FORK) covering sockfs user.* xattrs.
# xattr_socket_test and xattr_socket_types_test are held out because ramfs /tmp
# lacks user.* xattr support and non-AF_UNIX/netlink types may SKIP.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(xattr_sockfs_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "xattr_sockfs_test exited $rc"
echo "$out" | grep -q '^1\.\.14$' || fail "xattr_sockfs_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "xattr_sockfs_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 14 ] || fail "xattr_sockfs_test did not pass all fourteen tests"

echo "::vm-test::pass"
while :; do :; done
