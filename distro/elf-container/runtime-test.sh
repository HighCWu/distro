#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

program=${ELF_CONTAINER_PROGRAM:-/bin/elf-container-runtime}
helper=${ELF_CONTAINER_HELPER:-/bin/elf-container-helper}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'ELF container runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'ELF container diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  work=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devtmpfs (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount proc (status $status)"
fi

[ -c /dev/null ] || fail '/dev/null is not a character device'
[ -x "$program" ] || fail "program is not executable: $program"
[ -x "$helper" ] || fail "helper is not executable: $helper"

work=$(mktemp -d /tmp/elf-container-runtime.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

if ELF_CONTAINER_HELPER="$helper" "$program" "$work" \
  >"$work/program.stdout" 2>"$work/program.stderr"; then
  :
else
  status=$?
  fail "program exited with status $status"
fi

printf '%s\n' \
  'ELF container: posix_spawn argv environment PID PPID and inherited fd pass' \
  'ELF container: fexecve preserves PID and resets BSS TLS and CLOEXEC pass' \
  'ELF container: ENOEXEC rollback and raw/ELF exec recovery pass' \
  >"$work/program.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing expected phase output'
cmp "$work/program.expected" "$work/program.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'program phase output differs from expected order'
cat "$work/program.stdout"
status=$?
[ "$status" -eq 0 ] || fail 'reading program phase output'

rm -rf "$work"
status=$?
[ "$status" -eq 0 ] || fail 'temporary tree cleanup'
work=
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
