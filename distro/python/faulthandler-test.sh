#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export HOME=/tmp

if python3 /python-abi-test.py "$(cat /python-address-bits)" --installed-layout &&
  python3 -X faulthandler /faulthandler-test.py; then
  echo "::vm-test::pass"
else
  echo "::vm-test::fail"
fi
while :; do :; done
