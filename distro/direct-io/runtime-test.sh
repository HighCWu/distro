#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t devtmpfs devtmpfs /dev || {
  echo '::vm-test::fail: direct I/O device setup'
  exit 1
}
direct-io || exit 1
umount /dev || {
  echo '::vm-test::fail: direct I/O device cleanup'
  exit 1
}
echo '::vm-test::pass'
while :; do sleep 1; done
