#!/bin/busybox sh
# SPDX-License-Identifier: MIT
fail() {
  echo "::vm-test::fail: threaded resolver setup or application"
  while :; do :; done
}
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc proc /proc || fail
ip link set lo up || fail
# The test talks only to its own UDP server; never use an external DNS service.
printf 'nameserver 127.0.0.1\noptions timeout:2 attempts:1\n' >/etc/resolv.conf || fail
/bin/curl-resolver || fail
echo "::vm-test::pass"
while :; do :; done
