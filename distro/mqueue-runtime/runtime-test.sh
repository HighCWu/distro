#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

mkdir -p /dev/mqueue
mount -t mqueue none /dev/mqueue || {
  printf '%s\n' '::vm-test::fail: mount mqueue failed'
  while :; do sleep 1; done
}

output=$(mqueue-runtime 2>&1)
status=$?
printf '%s\n' "$output"
umount /dev/mqueue >/dev/null 2>&1 || true

if [ "$status" -ne 0 ]; then
  printf '%s\n' '::vm-test::fail: Linux mqueue consumer failed'
  while :; do sleep 1; done
fi

printf '%s\n' "$output" | grep -qx 'LINUX_MQUEUE_OK prio=20,10 notify=1' || {
  printf '%s\n' '::vm-test::fail: Linux mqueue output mismatch'
  while :; do sleep 1; done
}

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
