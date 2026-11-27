#!/bin/busybox sh

# Runs the forkless, module-free subset of splice kselftests:
#   * default_file_splice_read </dev/null - must emit 0 bytes.
#   * splice_read /proc/sys/kernel/version - full and 2-byte partial splice
#     through a pipe must match cat.
#   * splice_read /proc/self/comm          - seq_read pseudofiles have no
#     splice interface and must fail.
#
# short_splice_read.sh's test_module modprobe checks are held out because
# loadable kernel modules are not configured on this platform.

fail() {
  printf 'vm test guest failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t devtmpfs devtmpfs /dev || fail "mounting devtmpfs failed"
mount -t proc proc /proc || fail "mounting proc failed"
/vm-test-setup-dev-fd || fail "creating /dev/fd links failed"

leaked=$(default_file_splice_read </dev/null | wc -c)
[ "$leaked" -eq 0 ] || fail "default_file_splice_read leaked $leaked bytes"

full=$(cat /proc/sys/kernel/version) || fail "reading /proc/sys/kernel/version failed"
two=$(printf '%s\n' "$full" | cut -c-2)

out=$(splice_read /proc/sys/kernel/version 4096 | cat) || fail "full splice_read failed"
[ "$out" = "$full" ] || fail "full splice_read mismatch: '$out' vs '$full'"

out2=$(splice_read /proc/sys/kernel/version 2 | cat) || fail "partial splice_read failed"
[ "$out2" = "$two" ] || fail "partial splice_read mismatch: '$out2' vs '$two'"

if splice_read /proc/self/comm 4096 >/dev/null 2>&1; then
  fail "splice_read /proc/self/comm unexpectedly succeeded"
fi

echo "::vm-test::pass"
while :; do :; done
