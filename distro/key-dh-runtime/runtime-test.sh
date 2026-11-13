#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
output=$(key-dh-runtime) || exit 1
printf '%s\n' "$output" | grep -qx 'KEY_DH_COMPUTE_OK' || {
  echo 'missing raw KEY_DH_COMPUTE success marker' >&2
  exit 1
}
printf '%s\n' "$output" | grep -qx 'KEY_DH_KDF_SHA256_OK' || {
  echo 'missing SHA-256 KDF success marker' >&2
  exit 1
}
printf '%s\n' "$output"
echo '::vm-test::pass'
while :; do sleep 1; done
