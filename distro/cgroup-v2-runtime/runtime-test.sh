#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: cgroup-v2: $*"
  while :; do sleep 1; done
}

mkdir -p /proc /sys /tmp || fail 'mkdir /proc /sys /tmp'
mount -t proc proc /proc || fail 'mount proc'
mount -t sysfs sysfs /sys || fail 'mount sysfs'

out=$(cgroup-v2-runtime 2>&1)
rc=$?
umount /sys || fail 'umount sysfs'
umount /proc || fail 'umount proc'
[ "$rc" -eq 0 ] || fail "cgroup-v2-runtime failed (rc=$rc): $out"
printf '%s\n' "$out"

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
