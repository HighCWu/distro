#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'runtime check failure: %s\n' "$*"
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp || fail 'could not create temporary directory'
output=$(/bin/libpng-runtime) || fail 'libpng consumer failed'
expected='libpng-runtime: PNG encode/write and decode/read verified (3x2 RGBA, stride 12)'
[ "$output" = "$expected" ] || fail "unexpected consumer output: $output"

echo '::vm-test::pass'
while :; do sleep 1; done
