#!/bin/busybox sh

# Runs proc-fsconfig-hidepid (fsopen/fsconfig hidepid validation) and
# proc-2-is-kthread (/proc/2/status Kthread: 1) with zero skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

for bin in proc-fsconfig-hidepid proc-2-is-kthread; do
  out=$("$bin" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || fail "$bin exited $rc"
  echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "$bin reported a failure or skip"
done

echo "::vm-test::pass"
while :; do :; done
