#!/bin/busybox sh
# SPDX-License-Identifier: MIT

monitor_pid=
fail() {
  [ -z "$monitor_pid" ] || kill "$monitor_pid" 2>/dev/null || :
  printf '::vm-test::fail: busybox inotify: %s\n' "$*"
  while :; do :; done
}
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mount -t proc proc /proc || fail "mount proc"
mkdir -p /tmp/inotify-watch || fail "create watch directory"
/bin/busybox inotifyd - /tmp/inotify-watch:ncwmydDx >/tmp/inotify-events &
monitor_pid=$!

# Synchronize with the kernel's installed watch, not a guessed startup delay.
attempt=0
while ! grep -q '^inotify wd:' /proc/"$monitor_pid"/fdinfo/* 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 200 ] || fail "watch readiness deadline"
  sleep 0.05
done
echo 'busybox inotify: real applet installed directory watch pass'
printf 'data\n' >/tmp/inotify-watch/before || fail "write file"
mv /tmp/inotify-watch/before /tmp/inotify-watch/after || fail "rename file"
rm /tmp/inotify-watch/after || fail "delete file"
rmdir /tmp/inotify-watch || fail "remove directory"

attempt=0
while ! grep -q '^x' /tmp/inotify-events; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 200 ] || fail "ignored event deadline"
  sleep 0.05
done
wait "$monitor_pid" || fail "monitor exit"
monitor_pid=
tab=$(printf '\t')
for event in n c w m; do
  grep -qx "$event${tab}/tmp/inotify-watch${tab}before" /tmp/inotify-events || fail "missing $event before event"
done
for event in y d; do
  grep -qx "$event${tab}/tmp/inotify-watch${tab}after" /tmp/inotify-events || fail "missing $event after event"
done
grep -qx "D${tab}/tmp/inotify-watch" /tmp/inotify-events || fail "missing delete-self"
grep -qx "x${tab}/tmp/inotify-watch" /tmp/inotify-events || fail "missing ignored"
rm /tmp/inotify-events || fail "cleanup event capture"
echo 'busybox inotify: create, write, rename, delete, ignored and monitor reap pass'
echo '::vm-test::pass'
while :; do :; done
