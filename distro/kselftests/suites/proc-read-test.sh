#!/bin/busybox sh

# Runs tools/testing/selftests/proc/read to recursively read, lseek, and
# readlink every entry under /proc with zero skips.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(/bin/read 2>&1)
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "proc read exited $rc"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "proc read reported a failure or skip"

echo "::vm-test::pass"
while :; do :; done
