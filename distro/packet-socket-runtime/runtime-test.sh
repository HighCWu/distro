#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: packet-socket: $*"
  while :; do sleep 1; done
}

mkdir -p /proc || fail 'mkdir /proc'
mount -t proc proc /proc || fail 'mount proc'
/bin/busybox ifconfig lo 127.0.0.1 up || fail 'ifconfig lo up'

out=$(packet-socket-runtime 2>&1)
rc=$?
/bin/busybox ifconfig lo down || fail 'ifconfig lo down'
umount /proc || fail 'umount proc'
[ "$rc" -eq 0 ] || fail "packet-socket-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
