#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

fail() {
  echo "::vm-test::fail: loop devices: $*"
  exit 1
}

busybox mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
busybox mount -t sysfs sysfs /sys || fail "mount sysfs"
busybox mount -t proc proc /proc || fail "mount procfs"
mkdir /mnt/loop
test -c /dev/loop-control || fail "loop-control node"
test ! -e /dev/loop0 || fail "loop devices must start unallocated"
cp /fixture.ext4 /tmp/loop.ext4
case "$(losetup --version)" in
*util-linux*) ;;
*) fail "expected util-linux losetup" ;;
esac

loop=$(losetup --find --show /tmp/loop.ext4) || fail "attach writable image"
test -b "$loop" || fail "loop block node"
busybox mount -t ext4 "$loop" /mnt/loop || fail "mount writable image"
printf '%s\n' 'loop-backed ext4 writeback' >/mnt/loop/probe
busybox umount /mnt/loop || fail "unmount writable image"
losetup -d "$loop" || fail "detach writable image"
echo 'loop devices: allocated, mounted and wrote ext4'

loop=$(losetup --find --show --read-only /tmp/loop.ext4) || fail "reattach image read-only"
busybox mount -t ext4 -o ro "$loop" /mnt/loop || fail "mount read-only image"
test "$(cat /mnt/loop/probe)" = 'loop-backed ext4 writeback' || fail "backing-file persistence"
busybox umount /mnt/loop || fail "unmount read-only image"
losetup -d "$loop" || fail "detach read-only image"
test -z "$(losetup -a)" || fail "loop mappings remain attached"
echo 'loop devices: persisted contents and detached'
echo '::vm-test::pass'
while :; do sleep 1; done
