#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

if [ "$#" -gt 2 ]; then
  echo 'shell status test: expected optional SHELL and applet arguments' >&2
  exit 2
fi
if [ "$#" -gt 0 ]; then
  shell_program=$1
  shell_applet=${2-}
else
  shell_program=${SHELL_STATUS_PROGRAM:-/bin/busybox}
  shell_applet=${SHELL_STATUS_APPLET-sh}
fi
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'shell status runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'shell status diagnostic (%s):\n' "${diagnostic##*/}" >&2
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
  if [ "$status" -ne 0 ]; then
    fail "mount devtmpfs (status $status)"
  fi
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "mount proc (status $status)"
  fi
fi

[ -x "$shell_program" ] || fail "shell is not executable: $shell_program"
if [ -n "$shell_applet" ]; then
  "$shell_program" "$shell_applet" -c 'exit 0' >/dev/null 2>&1
else
  "$shell_program" -c 'exit 0' >/dev/null 2>&1
fi
status=$?
if [ "$status" -ne 0 ]; then
  fail "shell invocation failed (status $status)"
fi

work=$(mktemp -d /tmp/shell-status-test.XXXXXX 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$work" ]; then
  fail 'creating temporary directory'
fi
trap cleanup 0
helper=$work/exit-helper.sh
# Preserve the parameter expansion for the selected child shell.
# shellcheck disable=SC2016
printf '%s\n' 'exit "$1"' >"$helper"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing exit helper'
fi

run_child_shell() {
  if [ -n "$shell_applet" ]; then
    "$shell_program" "$shell_applet" -c "$1" shell-status \
      "$shell_program" "$shell_applet" "$helper"
  else
    "$shell_program" -c "$1" shell-status "$shell_program" "" "$helper"
  fi
}

phase_one=$(
  cat <<'PHASE_ONE'
program=$1
applet=$2
helper=$3
set -- "$program"
if [ -n "$applet" ]; then
  set -- "$@" "$applet"
fi
set -- "$@" "$helper"
if "$@" 37; then
  exit 41
else
  first_status=$?
  "$@" 19
  second_status=$?
fi
[ "$first_status" -eq 37 ] || exit 42
[ "$second_status" -eq 19 ] || exit 43
PHASE_ONE
)
run_child_shell "$phase_one" >"$work/phase-one.stdout" 2>"$work/phase-one.stderr"
phase_status=$?
if [ "$phase_status" -ne 0 ]; then
  fail "if/else did not preserve immediate failure statuses (status $phase_status)"
fi
[ ! -s "$work/phase-one.stdout" ] || fail 'phase one emitted unexpected output'
echo 'shell status: failed if condition and else preserve both exit statuses pass'

phase_two=$(
  cat <<'PHASE_TWO'
program=$1
applet=$2
helper=$3
set -- "$program"
if [ -n "$applet" ]; then
  set -- "$@" "$applet"
fi
set -- "$@" "$helper"

if "$@" 37; then
  exit 51
elif [ "$?" -eq 37 ]; then
  elif_success=1
else
  exit 52
fi
[ "${elif_success:-0}" -eq 1 ] || exit 53

then_seen=0
else_seen=0
if "$@" 0; then
  then_seen=1
else
  else_seen=1
fi
[ "$then_seen" -eq 1 ] && [ "$else_seen" -eq 0 ] || exit 54

if "$@" 37; then
  exit 55
elif "$@" 29; then
  exit 56
else
  elif_status=$?
fi
[ "${elif_status:-0}" -eq 29 ] || exit 57

if "$@" 41; then
  :
fi
no_else_status=$?
[ "$no_else_status" -eq 0 ] || exit 58
PHASE_TWO
)
run_child_shell "$phase_two" >"$work/phase-two.stdout" 2>"$work/phase-two.stderr"
phase_status=$?
if [ "$phase_status" -ne 0 ]; then
  fail "elif/no-else status checks failed (status $phase_status)"
fi
[ ! -s "$work/phase-two.stdout" ] || fail 'phase two emitted unexpected output'
echo 'shell status: elif and no-else compound statuses match POSIX pass'

phase_three=$(
  cat <<'PHASE_THREE'
program=$1
applet=$2
helper=$3
run_helper() {
  if [ -n "$applet" ]; then
    "$program" "$applet" "$helper" "$1"
  else
    "$program" "$helper" "$1"
  fi
}
failed_function() {
  run_helper 17
}
if failed_function; then
  exit 61
else
  function_status=$?
fi
[ "$function_status" -eq 17 ] || exit 62
(
  run_helper 23
)
subshell_status=$?
[ "$subshell_status" -eq 23 ] || exit 63
printf 'pipeline input\n' | run_helper 31
pipeline_status=$?
[ "$pipeline_status" -eq 31 ] || exit 64
run_helper 0
recovery_status=$?
[ "$recovery_status" -eq 0 ] || exit 65
PHASE_THREE
)
run_child_shell "$phase_three" >"$work/phase-three.stdout" 2>"$work/phase-three.stderr"
phase_status=$?
if [ "$phase_status" -ne 0 ]; then
  fail "function/subshell/pipeline status or recovery failed (status $phase_status)"
fi
[ ! -s "$work/phase-three.stdout" ] || fail 'phase three emitted unexpected output'
echo 'shell status: function subshell pipeline failure and recovery pass'

rm -rf "$work"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'temporary tree cleanup'
fi
work=
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
