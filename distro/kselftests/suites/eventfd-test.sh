#!/bin/busybox sh

# Runs all 9 TAP cases in tools/testing/selftests/filesystems/eventfd/eventfd_test
# (compiled with -DKSELFTEST_HARNESS_NO_FORK) covering eventfd2 flags and
# semaphore/non-semaphore read/write behavior.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(eventfd_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "eventfd_test exited $rc"
echo "$out" | grep -q '^1\.\.9$' || fail "eventfd_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "eventfd_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 9 ] || fail "eventfd_test did not pass all nine tests"

echo "::vm-test::pass"
while :; do :; done
