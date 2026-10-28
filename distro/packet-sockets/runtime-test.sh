#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
packet-sockets || exit 1
echo '::vm-test::pass'
while :; do sleep 1; done
