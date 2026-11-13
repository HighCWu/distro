#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

output=$(key-pkey-runtime /test-certificate.der 2>&1)
status=$?
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  echo '::vm-test::fail: asymmetric key query consumer failed'
  exit 1
fi
printf '%s\n' "$output" | grep -qx 'PKEY_QUERY_RESULT ops=1 bits=2048 data=256 sig=256 enc=256 dec=256 spare=zero' || {
  echo '::vm-test::fail: asymmetric key query result mismatch'
  exit 1
}
printf '%s\n' "$output" | grep -qx 'KEY_PKEY_QUERY_OK' || {
  echo '::vm-test::fail: asymmetric key query success marker missing'
  exit 1
}
echo '::vm-test::pass'
while :; do sleep 1; done
