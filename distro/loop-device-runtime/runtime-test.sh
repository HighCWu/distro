#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /mnt /tmp
mount -t devtmpfs devtmpfs /dev

cleanup() {
  umount /mnt >/dev/null 2>&1 || true
  rm -f /tmp/loop.img
  umount /dev >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -c /dev/loop-control ]; then
  echo "missing /dev/loop-control" >&2
  exit 1
fi

cp /share/loop-device-runtime/disk.img /tmp/loop.img
chmod 644 /tmp/loop.img

/bin/loop-device-runtime /tmp/loop.img

echo "::vm-test::pass"
