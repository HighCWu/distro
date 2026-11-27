#!/bin/busybox sh

# fchmodat2_test creates a temporary directory under /tmp, exercises
# fchmodat2(0) and fchmodat2(AT_SYMLINK_NOFOLLOW) on a regular file and a
# symlink, and checks resulting mode bits via fstatat(AT_SYMLINK_NOFOLLOW).
# On ramfs, simple_setattr allows symlink mode updates so both TAP cases pass
# without skipping.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

cd /tmp || fail "cd /tmp failed"
out=$(fchmodat2_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "fchmodat2_test exited $rc"
echo "$out" | grep -q '^1\.\.2$' || fail "fchmodat2_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "fchmodat2_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 2 ] || fail "fchmodat2_test did not pass both tests"

echo "::vm-test::pass"
while :; do :; done
