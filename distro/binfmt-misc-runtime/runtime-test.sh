#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /proc
mount -t proc proc /proc

cleanup() {
  umount /proc/sys/fs/binfmt_misc >/dev/null 2>&1 || true
  umount /proc >/dev/null 2>&1 || true
}
trap cleanup EXIT

/bin/binfmt-misc-runtime

echo "::vm-test::pass"
