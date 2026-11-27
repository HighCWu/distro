#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

output=$(sysvipc-runtime 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  printf '%s\n' '::vm-test::fail: Linux System V IPC consumer failed'
  while :; do sleep 1; done
fi

printf '%s\n' "$output" | grep -qx 'LINUX_SYSVIPC_OK sem=0 msg=2,1' || {
  printf '%s\n' '::vm-test::fail: Linux System V IPC output mismatch'
  while :; do sleep 1; done
}

printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
