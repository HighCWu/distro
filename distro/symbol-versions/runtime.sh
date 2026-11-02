#!/bin/busybox sh
# SPDX-License-Identifier: MIT
/bin/symbol-versions || {
  echo '::vm-test::fail: symbol-version application'
  while :; do :; done
}
echo '::vm-test::pass'
while :; do :; done
