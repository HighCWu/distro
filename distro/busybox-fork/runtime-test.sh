#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

busybox=${BUSYBOX_FORK_PROGRAM:-/opt/busybox-fork/bin/busybox}
helper=${BUSYBOX_FORK_HELPER:-/bin/busybox-fork-helper}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'busybox fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'busybox fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
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
  [ "$status" -eq 0 ] || fail "mounting devtmpfs (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mounting proc (status $status)"
fi
[ -c /dev/null ] || fail '/dev/null is not a character device'
[ -x "$busybox" ] || fail "BusyBox is not executable: $busybox"
[ -x "$helper" ] || fail "helper is not executable: $helper"

version=$("$busybox" 2>&1)
case "$version" in
*BusyBox*) ;;
*) fail 'expected a BusyBox binary' ;;
esac
"$busybox" ash -c 'exit 0' >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'BusyBox ash applet is unavailable'

work=$(mktemp -d /tmp/busybox-fork.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

# Keep these invocations inside ash and call the helper by absolute path so
# builtins cannot stand in for ordinary external child execution.
ash_log=$work/ash.log
# The single-quoted program is intentionally interpreted by the child Ash.
# shellcheck disable=SC2016
ash_output=$("$busybox" ash -c '
  helper=$1
  log=$2
  value=$("$helper" echo command substitution with spaces) || exit 31
  [ "$value" = "command substitution with spaces" ] || exit 32
  value=$("$helper" echo pipeline bytes | "$helper" copy) || exit 33
  [ "$value" = "pipeline bytes" ] || exit 34
  "$helper" record "$log" ash background-complete >/dev/null &
  child=$!
  wait "$child"
  status=$?
  [ "$status" -eq 0 ] || exit 35
  "$helper" exit 23
  status=$?
  [ "$status" -eq 23 ] || exit 36
  exit 0
' busybox-ash "$helper" "$ash_log" 2>"$work/ash.stderr")
status=$?
[ "$status" -eq 0 ] || fail "ash pipeline/subprocess checks (status $status)"
[ -z "$ash_output" ] || fail 'ash emitted unexpected command output'
grep -Fx 'ash|1|background-complete' "$ash_log" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'ash background helper did not record its arguments'
echo 'busybox fork: ash pipeline, command substitution, background wait and exit status pass'

# Exercise one helper invocation per find result and two explicit xargs batches.
find_tree="$work/find tree"
mkdir -p "$find_tree/sub" || fail 'creating find tree'
: >"$find_tree/first file"
status=$?
[ "$status" -eq 0 ] || fail 'creating first find file'
: >"$find_tree/second"
status=$?
[ "$status" -eq 0 ] || fail 'creating second find file'
: >"$find_tree/sub/third file"
status=$?
[ "$status" -eq 0 ] || fail 'creating third find file'

records=$work/arguments.log
"$busybox" find "$find_tree" -type f -exec "$helper" record "$records" find {} \; \
  >/dev/null 2>"$work/find.stderr"
status=$?
[ "$status" -eq 0 ] || fail "find -exec helper (status $status)"
find_count=$(grep -c '^find|' "$records" 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'counting find records'
[ "$find_count" -eq 3 ] || fail "find recorded $find_count arguments, expected 3"
for expected in "$find_tree/first file" "$find_tree/second" "$find_tree/sub/third file"; do
  grep -Fx "find|1|$expected" "$records" >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "find lost or split argument: $expected"
done

xargs_first="$find_tree/item one"
xargs_second="$find_tree/item two"
xargs_third="$find_tree/item three"
printf '%s\000' "$xargs_first" "$xargs_second" "$xargs_third" |
  "$busybox" xargs -0 -n 2 "$helper" record "$records" xargs \
    >"$work/xargs.stdout" 2>"$work/xargs.stderr"
status=$?
[ "$status" -eq 0 ] || fail "xargs helper batches (status $status)"
grep -Fx "xargs|2|$xargs_first|$xargs_second" "$records" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'xargs first two-argument batch changed grouping'
grep -Fx "xargs|1|$xargs_third" "$records" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'xargs final one-argument batch changed grouping'
xargs_count=$(grep -c '^xargs|' "$records" 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'counting xargs records'
[ "$xargs_count" -eq 2 ] || fail "xargs recorded $xargs_count batches, expected 2"
echo 'busybox fork: find -exec and xargs preserve every argument and batch boundary pass'

# BusyBox awk launches the helper with both system() and command | getline.
quote_path() {
  case "$1" in
  *"'"*) return 1 ;;
  esac
  printf "'%s'" "$1"
}

quoted_helper=$(quote_path "$helper")
status=$?
[ "$status" -eq 0 ] || fail 'helper path contains an unsupported quote'
awk_log=$work/awk.log
quoted_awk_log=$(quote_path "$awk_log")
status=$?
[ "$status" -eq 0 ] || fail 'awk log path contains an unsupported quote'
system_command="$quoted_helper record $quoted_awk_log awk-system invoked"
getline_command="$quoted_helper record $quoted_awk_log awk-getline reopened"
"$busybox" awk -v system_command="$system_command" \
  -v getline_command="$getline_command" '
  BEGIN {
    status = system(system_command)
    if (status != 0) exit 41
    if ((getline_command | getline value) != 1 || value != "record:awk-getline") exit 42
    print value
    if (close(getline_command) != 0) exit 43
    if ((getline_command | getline value) != 1 || value != "record:awk-getline") exit 44
    print value
    if (close(getline_command) != 0) exit 45
    print "awk: system and command-getline close/reopen pass"
  }
' >"$work/awk.stdout" 2>"$work/awk.stderr"
status=$?
[ "$status" -eq 0 ] || fail "awk subprocess checks (status $status)"
printf '%s\n' \
  'record:awk-system' \
  'record:awk-getline' \
  'record:awk-getline' \
  'awk: system and command-getline close/reopen pass' >"$work/awk.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing awk expected output'
cmp "$work/awk.expected" "$work/awk.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'awk output or child results changed'
grep -Fx 'awk-system|1|invoked' "$awk_log" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'awk system() helper was not recorded'
getline_count=$(grep -c '^awk-getline|' "$awk_log" 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'counting awk getline children'
[ "$getline_count" -eq 2 ] || fail 'awk close did not permit command reopen'
echo 'busybox fork: awk system and command-getline return, output and close/reopen pass'

# Exercise Ash's child failure status and recovery with fresh external children.
missing=$work/missing-command
[ ! -e "$missing" ] || fail 'missing-command fixture unexpectedly exists'
# Keep the positional-parameter reference for the child Ash to expand.
# shellcheck disable=SC2016
"$busybox" ash -c 'exec "$1"' busybox-ash "$missing" \
  >"$work/missing.stdout" 2>"$work/missing.stderr"
status=$?
[ "$status" -eq 127 ] || fail "missing exec returned $status, expected 127"

# shellcheck disable=SC2016
"$busybox" ash -c 'exec "$1" exit 7' busybox-ash "$helper" \
  >"$work/helper-failure.stdout" 2>"$work/helper-failure.stderr"
status=$?
[ "$status" -eq 7 ] || fail "helper failure returned $status, expected 7"

# shellcheck disable=SC2016
recovered=$("$busybox" ash -c 'exec "$1" echo recovered-child' \
  busybox-ash "$helper" 2>"$work/recovery.stderr")
status=$?
[ "$status" -eq 0 ] || fail "later ash child returned $status"
[ "$recovered" = recovered-child ] || fail 'later external child did not recover'
rm -rf "$work"
status=$?
[ "$status" -eq 0 ] || fail 'temporary tree cleanup'
work=
trap - 0
echo 'busybox fork: missing exec and helper failure statuses recover for later children pass'
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
