#!/bin/busybox sh
# SPDX-License-Identifier: MIT
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t devtmpfs devtmpfs /dev || exit 1
mkdir -p /dev/pts || exit 1
mount -t devpts devpts /dev/pts || exit 1
/bin/setsid --version || exit 1
/libexec/setsid-fork/verify || exit 1
umount /dev/pts || exit 1
umount /dev || exit 1
echo 'standard setsid: device fixture teardown pass'
echo '::vm-test::pass'
while :; do sleep 1; done
