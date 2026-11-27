#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /mnt /tmp
mount -t devtmpfs devtmpfs /dev

cleanup() {
  umount /mnt >/dev/null 2>&1 || true
  umount /dev >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -b /dev/vda ]; then
  echo "missing /dev/vda" >&2
  exit 1
fi

/bin/preadv2-pwritev2-fallocate-runtime

echo "::vm-test::pass"
