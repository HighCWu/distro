#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

output=$(aio-runtime 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  printf '%s\n' '::vm-test::fail: Linux AIO consumer failed'
  while :; do sleep 1; done
fi

printf '%s\n' "$output" | grep -qx 'LINUX_AIO_OK write=18 read=18 eventfd=2' || {
  printf '%s\n' '::vm-test::fail: Linux AIO completion contents mismatch'
  while :; do sleep 1; done
}

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
