#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: splice-pty: $*"
  while :; do sleep 1; done
}

mount -t devtmpfs devtmpfs /dev || fail 'mount devtmpfs'
mkdir -p /dev/pts /tmp || fail 'mkdir /dev/pts /tmp'
mount -t devpts devpts /dev/pts || fail 'mount devpts'

splice-pty-runtime
rc=$?
[ "$rc" -eq 0 ] || fail "splice-pty-runtime failed (rc=$rc)"

umount /dev/pts || fail 'umount devpts'
umount /dev || fail 'umount devtmpfs'
printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
