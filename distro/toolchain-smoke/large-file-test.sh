#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# The installed root is a disposable writable ext4 disk, not a multi-GiB image.
exec /large-file.wasm
echo '::vm-test::fail: large-file executable did not start'
while :; do :; done
