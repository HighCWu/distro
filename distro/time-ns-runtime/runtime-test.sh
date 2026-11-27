#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /proc
mount -t proc proc /proc

cleanup() {
  umount /proc >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ ! -e /proc/self/ns/time ]; then
  echo "missing /proc/self/ns/time" >&2
  exit 1
fi

/bin/time-ns-runtime

echo "::vm-test::pass"
