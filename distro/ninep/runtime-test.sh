#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

fail() {
  printf '::vm-test::fail: 9p transport: %s\n' "$*"
  exit 1
}

busybox mkdir -p /mnt/9p || fail "create mountpoint"
busybox timeout -s KILL 30 /mount-fd "$@" || fail "mount trans=fd"
echo '9p transport: mounted 9P2000.L over a vsock file descriptor'

listing=$(busybox timeout -s KILL 20 busybox ls -1 /mnt/9p) || fail "list remote directory"
printf '%s\n' "$listing" | busybox grep -Fxq message.txt || fail "find message.txt in directory listing"
echo '9p transport: listed remote directory'

busybox timeout -s KILL 20 /mount-fd --verify /mnt/9p/message.txt || fail "verify remote file bytes"
echo '9p transport: read exact remote file bytes'

if [ "${1:-}" = --memory ]; then
  busybox timeout -s KILL 30 /write-file /mnt/9p/written.bin /mnt/9p/alias.bin || fail "write and hard-link remote file"
else
  busybox timeout -s KILL 30 /write-file /mnt/9p/written.bin || fail "write and reopen remote file"
fi

busybox timeout -s KILL 20 busybox umount /mnt/9p || fail "unmount remote filesystem"
busybox rmdir /mnt/9p || fail "remove detached mountpoint"
echo '9p transport: unmounted remote filesystem'
echo '::vm-test::pass'
# Leave the machine running until the host sees the session detach unaided.
if [ "${1:-}" = --memory ]; then
  exec /bin/busybox sleep 300
fi
exec /bin/busybox poweroff -f
