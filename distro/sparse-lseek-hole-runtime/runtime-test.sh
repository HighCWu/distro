#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp
mount -t tmpfs tmpfs /tmp

cleanup() {
  umount /tmp >/dev/null 2>&1 || true
}
trap cleanup EXIT

/bin/sparse-lseek-hole-runtime

echo "::vm-test::pass"
