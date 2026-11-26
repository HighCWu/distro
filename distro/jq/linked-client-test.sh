#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

if libjq-static-client; then
  echo "::vm-test::pass"
else
  echo "::vm-test::fail: static libjq regex client failed with status $?"
fi
while :; do :; done
