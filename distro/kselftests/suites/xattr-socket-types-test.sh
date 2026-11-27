#!/bin/busybox sh

# Runs all 5 TAP cases in
# tools/testing/selftests/filesystems/xattr/xattr_socket_types_test
# (AF_INET, AF_INET6, AF_NETLINK, AF_PACKET, abstract AF_UNIX) compiled with
# -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(xattr_socket_types_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "xattr_socket_types_test exited $rc"
echo "$out" | grep -q '^1\.\.5$' || fail "xattr_socket_types_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "xattr_socket_types_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 5 ] || fail "xattr_socket_types_test did not pass all five tests"

echo "::vm-test::pass"
while :; do :; done
