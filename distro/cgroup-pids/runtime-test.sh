#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc proc /proc || exit 1
/bin/cgroup-pids || exit 1
echo '::vm-test::pass'
while :; do sleep 1; done
