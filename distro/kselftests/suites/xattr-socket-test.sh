#!/bin/busybox sh

# Runs all 50 TAP cases in
# tools/testing/selftests/filesystems/xattr/xattr_socket_test
# (16 xattr_socket tests x 3 socket types + 2 xattr_socket_trusted tests)
# compiled with -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"
mkdir -p /tmp || fail "creating /tmp failed"

out=$(xattr_socket_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "xattr_socket_test exited $rc"
echo "$out" | grep -q '^1\.\.50$' || fail "xattr_socket_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "xattr_socket_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 50 ] || fail "xattr_socket_test did not pass all 50 tests"

echo "::vm-test::pass"
while :; do :; done
