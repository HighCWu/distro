#!/bin/busybox sh

# Runs both TAP cases in tools/testing/selftests/filesystems/kernfs_test
# (kernfs_listxattr and kernfs_getxattr on /sys/kernel/warn_count) compiled
# with -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
mkdir -p /sys || fail "creating /sys failed"
mount -t sysfs sysfs /sys || fail "mounting sysfs failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(kernfs_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "kernfs_test exited $rc"
echo "$out" | grep -q '^1\.\.2$' || fail "kernfs_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "kernfs_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 2 ] || fail "kernfs_test did not pass both tests"

echo "::vm-test::pass"
while :; do :; done
