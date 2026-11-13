#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'runtime check failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

output=$(jpeg-roundtrip) || fail "JPEG API consumer failed"
[ "$output" = "LIBJPEG_ROUNDTRIP_OK" ] || fail "unexpected consumer output: $output"

echo "::vm-test::pass"
while :; do :; done
