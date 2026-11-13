#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

output=$(key-watch-runtime 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  printf '%s\n' '::vm-test::fail: key watch notification consumer failed'
  exit 1
fi
printf '%s\n' "$output" | grep -qx 'KEY_WATCH_NOTIFICATION_OK type=1 subtype=1 id=42 length=16' || {
  printf '%s\n' '::vm-test::fail: key notification contents mismatch'
  exit 1
}
printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
