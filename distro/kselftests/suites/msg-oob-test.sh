#!/bin/busybox sh

# Runs all 48 TAP cases in tools/testing/selftests/net/af_unix/msg_oob
# (24 MSG_OOB/SIOCATMARK/EPOLLPRI/SIGURG tests x no_peek/peek variants)
# compiled with -DKSELFTEST_HARNESS_NO_FORK.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

ip link set lo up 2>/dev/null || ifconfig lo 127.0.0.1 up 2>/dev/null || true

out=$(msg_oob 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "msg_oob exited $rc"
echo "$out" | grep -q '^1\.\.48$' || fail "msg_oob reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "msg_oob reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 48 ] || fail "msg_oob did not pass all 48 tests"

echo "::vm-test::pass"
while :; do :; done
