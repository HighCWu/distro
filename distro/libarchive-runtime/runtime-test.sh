#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
export TZ=UTC
umask 022

bsdtar=${BSDTAR_PROGRAM:-/bin/bsdtar}
native_reference=${NATIVE_REFERENCE:-0}
work_base=/tmp
workdir=
disk_mounted=0
xattr_helper=${XATTR_HELPER:-/bin/libarchive-xattr-helper}
getfacl=${GETFACL_PROGRAM:-/opt/acl-runtime/bin/getfacl}
setfacl=${SETFACL_PROGRAM:-/opt/acl-runtime/bin/setfacl}

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
  if [ "$disk_mounted" = 1 ]; then
    umount "$work_base" >/dev/null 2>&1 || true
    disk_mounted=0
  fi
}

fail() {
  printf 'libarchive runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.stdout "$workdir"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'libarchive diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  workdir=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

run_bsdtar() {
  label=$1
  shift
  if /bin/busybox timeout 30 "$bsdtar" "$@" \
    >"$workdir/$label.stdout" 2>"$workdir/$label.stderr"; then
    return 0
  else
    status=$?
    fail "$label exited with status $status"
  fi
}

run_xattr_helper() {
  label=$1
  operation=$2
  path=$3
  if "$xattr_helper" "$operation" "$path" \
    >"$workdir/$label.stdout" 2>"$workdir/$label.stderr"; then
    [ ! -s "$workdir/$label.stderr" ] || fail "$label wrote diagnostics"
    return 0
  else
    status=$?
    fail "$label exited with status $status"
  fi
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1 || fail 'mounting devtmpfs'
  mount -t proc proc /proc >/dev/null 2>&1 || fail 'mounting proc'
  mkdir -p /mnt/libarchive-runtime-xattr || fail 'creating ext4 mount point'
  mount -t ext4 -o acl,user_xattr /dev/vda /mnt/libarchive-runtime-xattr >/dev/null 2>&1 ||
    fail 'mounting ACL/xattr ext4 disk'
  work_base=/mnt/libarchive-runtime-xattr
  disk_mounted=1
fi

[ -x "$bsdtar" ] || fail "bsdtar is not executable: $bsdtar"
[ -x "$xattr_helper" ] || fail "xattr helper is not executable: $xattr_helper"
[ -x "$getfacl" ] || fail "getfacl is not executable: $getfacl"
[ -x "$setfacl" ] || fail "setfacl is not executable: $setfacl"
version=$("$bsdtar" --version 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail "bsdtar --version failed (status $status)"
case "$version" in
bsdtar*) ;;
*) fail "expected bsdtar: $version" ;;
esac

workdir=$(mktemp -d "$work_base/libarchive-runtime.XXXXXX")
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$workdir" ] || fail 'creating temporary directory'
trap cleanup EXIT

mkdir -p "$workdir/source/nested"
status=$?
[ "$status" -eq 0 ] || fail 'creating source tree'
printf '\000archive-bytes\377\n' >"$workdir/source/payload.bin"
status=$?
[ "$status" -eq 0 ] || fail 'writing binary payload'
if "$setfacl" -m 'u:1001:r--,g::---,m::r--,o::---' "$workdir/source/payload.bin" \
  >"$workdir/acl-set.stdout" 2>"$workdir/acl-set.stderr"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "setfacl exited with status $status"
[ ! -s "$workdir/acl-set.stderr" ] || fail 'setfacl wrote diagnostics'
printf 'user::rw-\nuser:1001:r--\ngroup::---\nmask::r--\nother::---\n' \
  >"$workdir/acl-expected.stdout"
printf '\n' >>"$workdir/acl-expected.stdout"
if "$getfacl" -cpn "$workdir/source/payload.bin" \
  >"$workdir/acl-before.stdout" 2>"$workdir/acl-get-before.stderr"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "getfacl before archive exited with status $status"
[ ! -s "$workdir/acl-get-before.stderr" ] || fail 'getfacl before archive wrote diagnostics'
cmp "$workdir/acl-expected.stdout" "$workdir/acl-before.stdout" >/dev/null 2>&1 ||
  fail 'source ACL entries or mask differ from expectation'
printf 'metadata survives extraction\n' >"$workdir/source/metadata.txt"
status=$?
[ "$status" -eq 0 ] || fail 'writing metadata fixture'
chmod 0751 "$workdir/source/metadata.txt"
status=$?
[ "$status" -eq 0 ] || fail 'setting metadata mode'
touch -t 202001020304.05 "$workdir/source/metadata.txt"
status=$?
[ "$status" -eq 0 ] || fail 'setting metadata timestamp'
printf 'nested file content\n' >"$workdir/source/nested/child.txt"
status=$?
[ "$status" -eq 0 ] || fail 'writing nested payload'
ln "$workdir/source/payload.bin" "$workdir/source/payload-hardlink"
status=$?
[ "$status" -eq 0 ] || fail 'creating hard link fixture'
ln -s payload.bin "$workdir/source/payload-symlink"
status=$?
[ "$status" -eq 0 ] || fail 'creating symbolic link fixture'
run_xattr_helper source-xattr-set set "$workdir/source/payload.bin"

run_bsdtar plain-create -c -f "$workdir/plain.tar" --xattrs --acls --format=pax \
  -C "$workdir/source" payload.bin payload-hardlink payload-symlink metadata.txt nested
[ -s "$workdir/plain.tar" ] || fail 'plain archive output is empty'
[ ! -s "$workdir/plain-create.stderr" ] || fail 'plain archive creation wrote diagnostics'
run_bsdtar plain-list -t -f "$workdir/plain.tar"
for expected_member in payload.bin payload-hardlink payload-symlink metadata.txt nested/ nested/child.txt; do
  grep -Fx "$expected_member" "$workdir/plain-list.stdout" >/dev/null 2>&1 ||
    fail "plain archive omitted $expected_member"
done

mkdir "$workdir/plain-extract"
status=$?
[ "$status" -eq 0 ] || fail 'creating plain extraction directory'
run_bsdtar plain-extract -x -f "$workdir/plain.tar" --xattrs --acls \
  -C "$workdir/plain-extract"
run_xattr_helper plain-xattr-check check "$workdir/plain-extract/payload.bin"
cmp "$workdir/source/payload.bin" "$workdir/plain-extract/payload.bin" >/dev/null 2>&1 ||
  fail 'plain extraction changed binary file contents'
cmp "$workdir/source/nested/child.txt" "$workdir/plain-extract/nested/child.txt" \
  >/dev/null 2>&1 || fail 'plain extraction changed nested file contents'
cmp "$workdir/source/metadata.txt" "$workdir/plain-extract/metadata.txt" \
  >/dev/null 2>&1 || fail 'plain extraction changed metadata file contents'
if "$getfacl" -cpn "$workdir/plain-extract/payload.bin" \
  >"$workdir/acl-after.stdout" 2>"$workdir/acl-get-after.stderr"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "getfacl after archive exited with status $status"
[ ! -s "$workdir/acl-get-after.stderr" ] || fail 'getfacl after archive wrote diagnostics'
cmp "$workdir/acl-before.stdout" "$workdir/acl-after.stdout" >/dev/null 2>&1 ||
  fail 'PAX archive changed restored ACL entries or mask'
cmp "$workdir/acl-expected.stdout" "$workdir/acl-after.stdout" >/dev/null 2>&1 ||
  fail 'restored ACL entries or mask differ from expectation'
source_mode=$(stat -c '%a' "$workdir/source/metadata.txt")
extracted_mode=$(stat -c '%a' "$workdir/plain-extract/metadata.txt")
[ "$source_mode" = "$extracted_mode" ] || fail 'plain extraction changed file mode'
source_mtime=$(stat -c '%Y' "$workdir/source/metadata.txt")
extracted_mtime=$(stat -c '%Y' "$workdir/plain-extract/metadata.txt")
[ "$source_mtime" = "$extracted_mtime" ] || fail 'plain extraction changed file mtime'
source_inode=$(stat -c '%i' "$workdir/source/payload.bin")
source_hard_inode=$(stat -c '%i' "$workdir/source/payload-hardlink")
extract_inode=$(stat -c '%i' "$workdir/plain-extract/payload.bin")
extract_hard_inode=$(stat -c '%i' "$workdir/plain-extract/payload-hardlink")
[ "$source_inode" = "$source_hard_inode" ] || fail 'source hardlink fixture is invalid'
[ "$extract_inode" = "$extract_hard_inode" ] || fail 'plain extraction lost hardlink identity'
[ -L "$workdir/plain-extract/payload-symlink" ] || fail 'plain extraction lost symlink type'
symlink_target=$(readlink "$workdir/plain-extract/payload-symlink")
[ "$symlink_target" = payload.bin ] || fail 'plain extraction changed symlink target'
printf '%s\n' 'libarchive: archive contents, bytes, metadata, and links verified'
printf '%s\n' 'libarchive: PAX user xattr round-trip verified'
printf '%s\n' 'libarchive: PAX named-user ACL and mask round-trip verified'

run_bsdtar filtered-create -c -f "$workdir/filtered.tar" --xattrs --format=pax \
  --use-compress-program=/bin/cat -C "$workdir/source" \
  payload.bin payload-hardlink payload-symlink metadata.txt nested
[ -s "$workdir/filtered.tar" ] || fail 'external cat filter produced no archive output'
[ ! -s "$workdir/filtered-create.stderr" ] || fail 'external cat filter wrote diagnostics'
mkdir "$workdir/filtered-extract"
status=$?
[ "$status" -eq 0 ] || fail 'creating filtered extraction directory'
run_bsdtar filtered-extract -x -f "$workdir/filtered.tar" --xattrs \
  -C "$workdir/filtered-extract"
run_xattr_helper filtered-xattr-check check \
  "$workdir/filtered-extract/payload.bin"
cmp "$workdir/source/payload.bin" "$workdir/filtered-extract/payload.bin" \
  >/dev/null 2>&1 || fail 'external cat filter changed archive payload'
cmp "$workdir/source/nested/child.txt" \
  "$workdir/filtered-extract/nested/child.txt" >/dev/null 2>&1 ||
  fail 'external cat filter changed nested payload'
filtered_inode=$(stat -c '%i' "$workdir/filtered-extract/payload.bin")
filtered_hard_inode=$(stat -c '%i' "$workdir/filtered-extract/payload-hardlink")
[ "$filtered_inode" = "$filtered_hard_inode" ] ||
  fail 'external cat filter lost hardlink identity'
printf '%s\n' 'libarchive: external cat filter produced a readable archive'

if /bin/busybox timeout 30 "$bsdtar" -c -f "$workdir/failed.tar" \
  --xattrs --format=pax --use-compress-program=/bin/false -C "$workdir/source" \
  payload.bin payload-hardlink payload-symlink metadata.txt nested \
  >"$workdir/failed-filter.stdout" 2>"$workdir/failed-filter.stderr"; then
  fail 'nonzero external filter unexpectedly succeeded'
else
  status=$?
fi
case "$status" in
124 | 137 | 143) fail "external filter failure hit the watchdog (status $status)" ;;
esac
[ -s "$workdir/failed-filter.stderr" ] || fail 'failed external filter had no diagnostic'
printf '%s\n' 'libarchive: nonzero external filter failed and was reaped'

run_bsdtar recovery-create -c -f "$workdir/recovery.tar" --xattrs --format=pax \
  --use-compress-program=/bin/cat -C "$workdir/source" \
  payload.bin payload-hardlink payload-symlink metadata.txt nested
[ -s "$workdir/recovery.tar" ] || fail 'filter recovery archive is empty'
mkdir "$workdir/recovery-extract"
status=$?
[ "$status" -eq 0 ] || fail 'creating recovery extraction directory'
run_bsdtar recovery-extract -x -f "$workdir/recovery.tar" --xattrs \
  -C "$workdir/recovery-extract"
run_xattr_helper recovery-xattr-check check \
  "$workdir/recovery-extract/payload.bin"
cmp "$workdir/source/payload.bin" "$workdir/recovery-extract/payload.bin" \
  >/dev/null 2>&1 || fail 'archive operations did not recover after filter error'
cmp "$workdir/source/nested/child.txt" \
  "$workdir/recovery-extract/nested/child.txt" >/dev/null 2>&1 ||
  fail 'recovery archive contained wrong nested data'
[ -L "$workdir/recovery-extract/payload-symlink" ] ||
  fail 'recovery archive lost symlink metadata'
printf '%s\n' 'libarchive: successful external-filter operation recovered after error'

cleanup
workdir=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
