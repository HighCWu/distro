#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev
mount -t devtmpfs devtmpfs /dev

cleanup() {
  umount /dev >/dev/null 2>&1 || true
}
trap cleanup EXIT

/bin/getrandom-urandom-prng-runtime

echo "::vm-test::pass"
