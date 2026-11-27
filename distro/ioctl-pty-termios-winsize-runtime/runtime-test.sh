#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /dev /dev/pts
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts

cleanup() {
  umount /dev/pts >/dev/null 2>&1 || true
  umount /dev >/dev/null 2>&1 || true
}
trap cleanup EXIT

/bin/ioctl-pty-termios-winsize-runtime

echo "::vm-test::pass"
