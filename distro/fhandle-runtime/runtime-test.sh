#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: fhandle: $*"
  while :; do sleep 1; done
}

mkdir -p /dev /proc /tmp || fail 'mkdir /dev /proc /tmp'
mount -t devtmpfs devtmpfs /dev || fail 'mount devtmpfs'
mount -t proc proc /proc || fail 'mount proc'

out=$(fhandle-runtime 2>&1)
rc=$?
umount /proc || fail 'umount proc'
umount /dev || fail 'umount devtmpfs'
[ "$rc" -eq 0 ] || fail "fhandle-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
