#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

program=${LIBUV_RUNTIME_PROGRAM:-/bin/libuv-runtime}
helper=${LIBUV_HELPER_PROGRAM:-/bin/libuv-helper}
native_reference=${NATIVE_REFERENCE:-0}
workdir=

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
}

fail() {
  printf 'libuv runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.out "$workdir"/*.err; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'libuv runtime diagnostic (%s):\n' "${diagnostic##*/}" >&2
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
workdir=$(mktemp -d /tmp/libuv-runtime.XXXXXX)
status=$?
[ "$status" -eq 0 ] || fail 'create temporary directory'
[ -n "$workdir" ] || fail 'create temporary directory'

if LIBUV_HELPER_PATH="$helper" "$program" >"$workdir/program.out" 2>"$workdir/program.err"; then
  :
else
  status=$?
  fail "program exited with status $status"
fi

cat >"$workdir/expected.out" <<'EOF'
libuv: spawn argv/stdout/exit/reap ok
libuv: async fs write/fsync/read/stat/close/unlink ok
libuv: unix pipe binary echo and timer ok
EOF
if ! cmp -s "$workdir/expected.out" "$workdir/program.out"; then
  fail 'program phase markers were missing, duplicated, or out of order'
fi
if [ -s "$workdir/program.err" ]; then
  fail 'program wrote unexpected error output'
fi

cat "$workdir/program.out"
status=$?
[ "$status" -eq 0 ] || fail 'reading program phase markers'
cleanup
workdir=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
