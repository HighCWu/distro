#!/bin/busybox sh

# Runs proc-uptime-002 verifying sched_getaffinity/sched_setaffinity and
# /proc/uptime vs CLOCK_BOOTTIME monotonicity with zero skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(proc-uptime-002 2>&1)
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "proc-uptime-002 exited $rc"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "proc-uptime-002 reported a failure or skip"

echo "::vm-test::pass"
while :; do :; done
