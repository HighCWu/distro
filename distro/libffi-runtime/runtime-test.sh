#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'libffi runtime check failed: %s\n' "$*"
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

output=$(/bin/libffi-runtime) || fail 'ffi_call consumer failed'
expected='LIBFFI_RUNTIME_MIXED_CALL_OK'
[ "$output" = "$expected" ] || fail "unexpected consumer output: $output"

echo '::vm-test::pass'
while :; do sleep 1; done
