#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: memfd-seals: $*"
  while :; do sleep 1; done
}

out=$(memfd-seals-runtime 2>&1)
rc=$?
[ "$rc" -eq 0 ] || fail "memfd-seals-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
