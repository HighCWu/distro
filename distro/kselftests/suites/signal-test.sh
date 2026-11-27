#!/bin/busybox sh

# Runs all 7 TAP cases in tools/testing/selftests/signal/mangle_uc_sigmask
# verifying sa_mask blocking, ucontext_t.uc_sigmask restoration across
# sigreturn, and standard signal coalescing on CONFIG_MMU=n.
# sas is held out because it relies on mmap() and arch-specific SP helpers.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(mangle_uc_sigmask 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "mangle_uc_sigmask exited $rc"
echo "$out" | grep -q '^1\.\.7$' || fail "mangle_uc_sigmask reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "mangle_uc_sigmask reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 7 ] || fail "mangle_uc_sigmask did not pass all seven tests"

echo "::vm-test::pass"
while :; do :; done
