#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/tmp

if python3 /python-abi-test.py "$(cat /python-address-bits)" &&
  python3 /mmap-test.py --kernel-boundaries; then
  echo "::vm-test::pass"
else
  echo "::vm-test::fail"
fi
while :; do :; done
