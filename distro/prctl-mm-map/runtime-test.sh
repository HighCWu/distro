#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mount -t proc proc /proc || {
  echo "::vm-test::fail: mounting proc failed"
  exit 1
}

/bin/prctl-mm-map || {
  echo "::vm-test::fail: prctl-mm-map runtime failed"
  exit 1
}

echo "::vm-test::pass"
while :; do sleep 1; done
