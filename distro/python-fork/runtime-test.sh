#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/usr/bin:/bin:/sbin:/usr/sbin
export LC_ALL=C

fail() {
  printf 'python fork runtime failure: %s\n' "$*" >&2
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail "mount devtmpfs failed (status $status)"
fi
mount -t proc proc /proc >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail "mount proc failed (status $status)"
fi

if [ ! -x /usr/bin/python3.13 ]; then
  fail 'required /usr/bin/python3.13 is not executable'
fi
if [ ! -r /python-address-bits ]; then
  fail 'missing /python-address-bits'
fi
if [ ! -r /python-abi-test.py ]; then
  fail 'missing installed Python ABI test'
fi
if [ ! -r /python-fork-runtime.py ]; then
  fail 'missing Python fork runtime test'
fi

address_bits=$(cat /python-address-bits)
status=$?
if [ "$status" -ne 0 ]; then
  fail "reading Python address width failed (status $status)"
fi
case "$address_bits" in
32 | 64) ;;
*) fail "invalid Python address width: $address_bits" ;;
esac

/usr/bin/python3.13 -I -B /python-abi-test.py "$address_bits" --installed-layout
status=$?
if [ "$status" -ne 0 ]; then
  fail "installed Python ABI test failed (status $status)"
fi

/usr/bin/python3.13 -I -B /python-fork-runtime.py
status=$?
if [ "$status" -ne 0 ]; then
  fail "Python fork runtime failed (status $status)"
fi

echo '::vm-test::pass'
exit 0
