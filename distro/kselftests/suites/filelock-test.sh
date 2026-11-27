#!/bin/busybox sh

# ofdlocks opens two independent file descriptions on /tmp/aa, unlinks the
# path, and exercises F_OFD_SETLK / F_OFD_GETLK / F_UNLCK read/write lock
# conflicts and releases. No fork, mmap, or namespaces are required.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

cd /tmp || fail "cd /tmp failed"
out=$(ofdlocks 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "ofdlocks exited $rc"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "ofdlocks reported a failure or skip"

echo "::vm-test::pass"
while :; do :; done
