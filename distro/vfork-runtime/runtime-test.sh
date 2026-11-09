#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

program=${VFORK_RUNTIME_PROGRAM:-/bin/vfork-runtime}
helper=${VFORK_RUNTIME_HELPER:-/bin/vfork-helper}
native_reference=${NATIVE_REFERENCE:-0}
workdir=

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
}

fail() {
  printf 'vfork runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.out "$workdir"/*.err; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'vfork runtime diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

trap cleanup EXIT

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev || fail 'mounting devtmpfs'
  mount -t proc proc /proc || fail 'mounting proc'
fi

[ -x "$program" ] || fail "program is not executable: $program"
[ -x "$helper" ] || fail "helper is not executable: $helper"
workdir=$(mktemp -d /tmp/vfork-runtime.XXXXXX)
status=$?
[ "$status" -eq 0 ] || fail 'create temporary directory'
[ -n "$workdir" ] || fail 'create temporary directory'

if VFORK_RUNTIME_HELPER="$helper" "$program" "$helper" \
  >"$workdir/program.out" 2>"$workdir/program.err"; then
  :
else
  status=$?
  fail "program exited with status $status"
fi

cat "$workdir/program.out"
status=$?
[ "$status" -eq 0 ] || fail 'read program stage markers'
rm -rf "$workdir"
status=$?
[ "$status" -eq 0 ] || fail 'remove temporary directory'
workdir=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
