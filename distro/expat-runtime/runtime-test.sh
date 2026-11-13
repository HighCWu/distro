#!/bin/busybox sh
# SPDX-License-Identifier: MIT

fail() {
  printf 'runtime check failure: %s\n' "$*"
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

output=$(/bin/expat-runtime) || fail 'Expat consumer failed'
expected='expat-runtime: streamed UTF-8 namespace/attribute parse and malformed-input diagnostic verified'
[ "$output" = "$expected" ] || fail "unexpected consumer output: $output"

echo '::vm-test::pass'
while :; do sleep 1; done
