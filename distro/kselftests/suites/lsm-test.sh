#!/bin/busybox sh

# Runs all 10 TAP cases in tools/testing/selftests/lsm:
#   * lsm_get_self_attr_test (6 TAP cases)
#   * lsm_set_self_attr_test (4 TAP cases)
# compiled with -DKSELFTEST_HARNESS_NO_FORK.
# lsm_list_modules_test is held out because it requires /sys/kernel/security/lsm
# (CONFIG_SECURITYFS=y).

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

out=$(lsm_get_self_attr_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "lsm_get_self_attr_test exited $rc"
echo "$out" | grep -q '^1\.\.6$' || fail "lsm_get_self_attr_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "lsm_get_self_attr_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 6 ] || fail "lsm_get_self_attr_test did not pass all six tests"

out=$(lsm_set_self_attr_test 2>&1)
rc=$?
printf '%s\n' "$out"
[ "$rc" -eq 0 ] || fail "lsm_set_self_attr_test exited $rc"
echo "$out" | grep -q '^1\.\.4$' || fail "lsm_set_self_attr_test reported an unexpected TAP plan"
echo "$out" | grep -Eq '^not ok|#[[:space:]]*SKIP|FAIL' && fail "lsm_set_self_attr_test reported a failure or skip"
[ "$(echo "$out" | grep -c '^ok [0-9]')" -eq 4 ] || fail "lsm_set_self_attr_test did not pass all four tests"

echo "::vm-test::pass"
while :; do :; done
