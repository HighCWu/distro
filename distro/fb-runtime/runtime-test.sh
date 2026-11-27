#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: fb: $*"
  while :; do sleep 1; done
}

mount -t devtmpfs devtmpfs /dev || fail 'mount devtmpfs'
out=$(fb-runtime 2>&1) || fail "fb-runtime failed: $out"
printf '%s\n' "$out"
umount /dev || fail 'umount devtmpfs'
printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
