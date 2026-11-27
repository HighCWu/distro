#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: rtnetlink: $*"
  while :; do sleep 1; done
}

out=$(rtnetlink-runtime 2>&1)
rc=$?
[ "$rc" -eq 0 ] || fail "rtnetlink-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
