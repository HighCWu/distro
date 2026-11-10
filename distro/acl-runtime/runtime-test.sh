#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
export TZ=UTC
umask 022

runtime=${ACL_RUNTIME:-/opt/acl-runtime/bin/acl-runtime}
native_reference=${NATIVE_REFERENCE:-0}
mountpoint=/mnt/acl-runtime-test
workdir=
mounted=0

cleanup() {
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    rm -rf "$workdir"
  fi
  workdir=
  if [ "$mounted" = 1 ]; then
    umount "$mountpoint" >/dev/null 2>&1 || true
    mounted=0
  fi
}

fail() {
  printf 'acl runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.stdout "$workdir"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'acl diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 30 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

[ -x "$runtime" ] || fail "ACL C consumer is not executable: $runtime"

if [ "$native_reference" = 1 ]; then
  workdir=$(mktemp -d "${ACL_TEST_DIRECTORY:-/tmp}/acl-runtime.XXXXXX")
  status=$?
  [ "$status" -eq 0 ] || fail 'creating host reference directory'
  [ -n "$workdir" ] || fail 'creating host reference directory'
else
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1 || fail 'mounting devtmpfs'
  mount -t proc proc /proc >/dev/null 2>&1 || fail 'mounting proc'
  mkdir -p "$mountpoint" || fail 'creating ext4 mount point'
  mount -t ext4 -o acl /dev/vda "$mountpoint" >/dev/null 2>&1 ||
    fail 'mounting the fresh ext4 test disk with POSIX ACL support'
  mounted=1
  workdir=$(mktemp -d "$mountpoint/acl-runtime.XXXXXX")
  status=$?
  [ "$status" -eq 0 ] || fail 'creating ACL test directory on ext4'
  [ -n "$workdir" ] || fail 'creating ACL test directory on ext4'
fi
chmod 0755 "$workdir" || fail 'allowing the test user to traverse the fixture directory'
trap cleanup EXIT

if /bin/busybox timeout 30 "$runtime" "$workdir/acl-file" \
  >"$workdir/runtime.stdout" 2>"$workdir/runtime.stderr"; then
  status=0
else
  status=$?
fi
case "$status" in
124 | 137 | 143) fail "ACL C consumer hit the 30 second watchdog (status $status)" ;;
esac
[ "$status" -eq 0 ] || fail "ACL C consumer exited with status $status"
[ ! -s "$workdir/runtime.stderr" ] || fail 'ACL C consumer wrote diagnostics on success'
grep -Fx 'acl: requested access entries and mode mask were read back' \
  "$workdir/runtime.stdout" >/dev/null 2>&1 || fail 'ACL readback stage did not complete'
grep -Fx 'acl: uid/gid 1001 read the payload, write was EACCES, and parent credentials stayed root' \
  "$workdir/runtime.stdout" >/dev/null 2>&1 || fail 'ACL permission enforcement stage did not complete'
grep -Fx 'acl: removing the named user denied the next child read and the child was reaped' \
  "$workdir/runtime.stdout" >/dev/null 2>&1 || fail 'ACL removal/recovery stage did not complete'
cat "$workdir/runtime.stdout"

if [ "$mounted" = 1 ]; then
  rm -rf "$workdir"
  workdir=
  umount "$mountpoint" || fail 'unmounting the ACL test disk'
  mounted=0
fi
cleanup
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
