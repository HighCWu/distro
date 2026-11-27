#!/bin/busybox sh

# Runs both TAP cases in tools/testing/selftests/filesystems/statmount/listmount_test
# (listmount_forward and listmount_backward) compiled with
# -DKSELFTEST_HARNESS_NO_FORK.
# statmount_test and statmount_test_ns are held out because they require
# mount/user/pid namespaces.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(listmount_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "listmount_test exited $rc"
echo "$out" | grep -q '^1\.\.2$' || fail "listmount_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "listmount_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 2 ] || fail "listmount_test did not pass both tests"

echo "::vm-test::pass"
while :; do :; done
