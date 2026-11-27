#!/bin/busybox sh

# Runs all 132 TAP cases in tools/testing/selftests/net/bind_wildcard
# (44 IPv4/IPv6 address/IPV6_V6ONLY variants x plain/SO_REUSEADDR/SO_REUSEPORT)
# compiled with -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

out=$(bind_wildcard 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "bind_wildcard exited $rc"
echo "$out" | grep -q '^1\.\.132$' || fail "bind_wildcard reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "bind_wildcard reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 132 ] || fail "bind_wildcard did not pass all 132 tests"

echo "::vm-test::pass"
while :; do :; done
