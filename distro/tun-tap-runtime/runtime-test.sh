#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: tun-tap: $*"
  while :; do sleep 1; done
}

mkdir -p /dev || fail 'mkdir /dev'
mount -t devtmpfs devtmpfs /dev || fail 'mount devtmpfs'
[ -c /dev/net/tun ] || fail '/dev/net/tun missing'

out=$(tun-tap-runtime 2>&1)
rc=$?
umount /dev || fail 'umount devtmpfs'
[ "$rc" -eq 0 ] || fail "tun-tap-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
