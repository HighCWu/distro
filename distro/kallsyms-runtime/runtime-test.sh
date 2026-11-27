#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: kallsyms: $*"
  while :; do sleep 1; done
}

mount -t proc proc /proc || fail 'mount proc'

output=$(kallsyms-runtime 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  fail "kallsyms-runtime exited with $status"
fi

printf '%s\n' "$output" | grep -Eq '^KALLSYMS_OK count=[1-9][0-9]* nonzero=[1-9][0-9]*$' || fail 'unexpected kallsyms output'

umount /proc || fail 'umount proc'
printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
