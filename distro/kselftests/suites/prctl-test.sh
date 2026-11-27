#!/bin/busybox sh

# Runs the forkless, architecture-independent prctl kselftest set-process-name
# (1 TAP case: rename_process) compiled with -DKSELFTEST_HARNESS_NO_FORK.
# x86 TSC tests and set-anon-vma-name-test (CONFIG_ANON_VMA_NAME / mmap) are
# held out.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(set-process-name 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "set-process-name exited $rc"
echo "$out" | grep -q '^1\.\.1$' || fail "set-process-name reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "set-process-name reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 1 ] || fail "set-process-name did not pass"

echo "::vm-test::pass"
while :; do :; done
