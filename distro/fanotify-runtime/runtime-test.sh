#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: fanotify: $*"
  while :; do sleep 1; done
}

mkdir -p /tmp || fail 'mkdir /tmp'

out=$(fanotify-runtime 2>&1)
rc=$?
[ "$rc" -eq 0 ] || fail "fanotify-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
