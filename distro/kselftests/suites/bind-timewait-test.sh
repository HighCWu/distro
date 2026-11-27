#!/bin/busybox sh

# Runs both TAP cases in tools/testing/selftests/net/bind_timewait
# (localhost and addrany TIME_WAIT bind EADDRINUSE checks) compiled with
# -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

ip link set lo up 2>/dev/null || ifconfig lo 127.0.0.1 up 2>/dev/null || true

out=$(bind_timewait 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "bind_timewait exited $rc"
echo "$out" | grep -q '^1\.\.2$' || fail "bind_timewait reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "bind_timewait reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 2 ] || fail "bind_timewait did not pass both tests"

echo "::vm-test::pass"
while :; do :; done
