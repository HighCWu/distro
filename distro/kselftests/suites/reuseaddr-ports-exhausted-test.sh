#!/bin/busybox sh

# Runs all 3 TAP cases in tools/testing/selftests/net/reuseaddr_ports_exhausted
# after pinning net.ipv4.ip_local_port_range to a single ephemeral port
# (32768 32768) so bind(127.0.0.1:0) exercises the full SO_REUSEADDR /
# SO_REUSEPORT / EUID conflict matrix.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

ip link set lo up 2>/dev/null || ifconfig lo 127.0.0.1 up 2>/dev/null || true
echo "32768 32768" >/proc/sys/net/ipv4/ip_local_port_range || fail "setting ip_local_port_range failed"

out=$(reuseaddr_ports_exhausted 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "reuseaddr_ports_exhausted exited $rc"
echo "$out" | grep -q '^1\.\.3$' || fail "reuseaddr_ports_exhausted reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "reuseaddr_ports_exhausted reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 3 ] || fail "reuseaddr_ports_exhausted did not pass all three tests"

echo "::vm-test::pass"
while :; do :; done
