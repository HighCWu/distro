#!/bin/busybox sh

# Runs proc-subset-pid verifying unshare(CLONE_NEWNS) + proc subset=pid
# isolation with zero skips (exit 4 on ENOSYS/EPERM is treated as failure).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(proc-subset-pid 2>&1)
rc=$?
[ -n "$out" ] && printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "proc-subset-pid exited $rc"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "proc-subset-pid reported a failure or skip"

echo "::vm-test::pass"
while :; do :; done
