#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

output=$(io-uring-runtime 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  printf '%s\n' '::vm-test::fail: Linux io_uring consumer failed'
  while :; do sleep 1; done
fi

printf '%s\n' "$output" | grep -qx 'LINUX_IO_URING_OK nop=0 write=23 read=23 fixed_file=1 reg_ring=1' || {
  printf '%s\n' '::vm-test::fail: Linux io_uring completion contents mismatch'
  while :; do sleep 1; done
}

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
