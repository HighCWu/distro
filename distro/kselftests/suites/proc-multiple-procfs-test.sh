#!/bin/busybox sh

# Runs proc-multiple-procfs (independent hidepid=1/hidepid=2 procfs mounts)
# and fd-003-kthread (/proc/2/fd emptiness) with zero skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"
mkdir -p /tmp || fail "creating /tmp failed"

for bin in proc-multiple-procfs fd-003-kthread; do
  out=$("$bin" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail "$bin exited $rc"
  echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "$bin reported a failure or skip"
done

echo "::vm-test::pass"
while :; do :; done
