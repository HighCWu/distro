#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# shellcheck shell=sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C SHELL=/bin/sh

find_binary=${FIND_FORK_PROGRAM:-/bin/find}
xargs_binary=${XARGS_FORK_PROGRAM:-/bin/xargs}
helper=${FIND_FORK_HELPER:-/bin/find-fork-helper}
native_reference=${NATIVE_REFERENCE:-0}
work=

fail() {
  printf '::vm-test::fail: findutils fork: %s\n' "$*"
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr; do
      if [ -f "$diagnostic" ]; then
        printf 'findutils fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
    rm -rf "$work"
  fi
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  while :; do sleep 1; done
}

version=$("$find_binary" --version 2>/dev/null) || fail 'GNU find unavailable'
case "$version" in
*'GNU findutils'*) ;;
*) fail 'expected GNU find' ;;
esac
version=$("$xargs_binary" --version 2>/dev/null) || fail 'GNU xargs unavailable'
case "$version" in
*'GNU findutils'*) ;;
*) fail 'expected GNU xargs' ;;
esac
[ -x "$helper" ] || fail "missing helper: $helper"

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev || fail 'mounting devtmpfs'
  mount -t proc proc /proc || fail 'mounting proc'
fi
[ -c /dev/null ] || fail '/dev/null is not a character device'

work=$(mktemp -d /tmp/findutils-fork.XXXXXX 2>/dev/null) || fail 'temporary directory'
single_tree=$work/single
mkdir -p "$single_tree/sub" || fail 'single-command tree'
: >"$single_tree/alpha.txt" || fail 'single-command file'
: >"$single_tree/with space.txt" || fail 'single-command spaced file'
: >"$single_tree/sub/beta.txt" || fail 'single-command nested file'
single_parent=$work/find-parent.pid
single_log=$work/single.log

(
  cd "$single_tree" || exit 125
  FIND_FORK_PARENT_FILE="$single_parent" FIND_FORK_SINGLE_LOG="$single_log" \
    sh -c 'printf "%s\n" "$$" >"$1" || exit 125; shift; exec "$@"' \
    find-fork-wrapper "$single_parent" "$find_binary" . -type f \
    -exec "$helper" single "$single_tree" {} \;
) >"$work/single.stdout" 2>"$work/single.stderr" &
find_job=$!
wait "$find_job"
status=$?
[ "$status" -eq 0 ] || fail "find -exec returned $status"
[ -s "$single_log" ] || fail 'find -exec helper did not run'
count=$(wc -l <"$single_log") || fail 'counting -exec calls'
[ "$count" -eq 3 ] || fail "find -exec helper count was $count"
grep -F '|./alpha.txt' "$single_log" >/dev/null || fail '-exec alpha argument'
grep -F '|./with space.txt' "$single_log" >/dev/null || fail '-exec spaced argument'
grep -F '|./sub/beta.txt' "$single_log" >/dev/null || fail '-exec nested argument'
echo 'find fork: -exec direct children preserve cwd, arguments and live parent pass'

execdir_tree="$work/execdir with space"
mkdir -p "$execdir_tree" || fail 'execdir tree'
: >"$execdir_tree/first file.txt" || fail 'execdir first file'
: >"$execdir_tree/second.txt" || fail 'execdir second file'
: >"$execdir_tree/third file.txt" || fail 'execdir third file'
execdir_log=$work/execdir.log
FIND_FORK_EXECDIR_LOG="$execdir_log" "$find_binary" "$execdir_tree" -type f \
  -execdir "$helper" execdir "$execdir_tree" {} + \
  >/dev/null 2>"$work/execdir.stderr"
status=$?
[ "$status" -eq 0 ] || fail "find -execdir returned $status"
grep -Fx 'batch=3' "$execdir_log" >/dev/null || fail '-execdir did not batch all arguments'
echo 'find fork: -execdir preserves spaced paths and batched arguments pass'

xargs_tree="$work/xargs with space"
handshake=$work/handshake
mkdir -p "$xargs_tree" "$handshake" || fail 'xargs work directories'
: >"$xargs_tree/item one" || fail 'xargs first file'
: >"$xargs_tree/item two" || fail 'xargs second file'
printf '%s\000' "$xargs_tree/item one" "$xargs_tree/item two" >"$work/arguments.nul" ||
  fail 'NUL-delimited xargs input'
FIND_FORK_HANDSHAKE_DIR="$handshake" "$xargs_binary" -0 -n 1 -P 2 \
  --process-slot-var=FIND_FORK_SLOT "$helper" parallel "$xargs_tree" \
  <"$work/arguments.nul" >"$work/xargs.stdout" 2>"$work/xargs.stderr"
status=$?
[ "$status" -eq 0 ] || fail "xargs parallel batch returned $status"
for slot in 0 1; do
  [ -s "$handshake/ready-$slot" ] || fail "xargs slot $slot did not become ready"
  [ -s "$handshake/seen-$slot" ] || fail "xargs slot $slot missed the overlap barrier"
done
echo 'find fork: xargs null input, dev-null stdin, parallel slots and overlap pass'

recovery_tree=$work/recovery
mkdir -p "$recovery_tree" || fail 'recovery tree'
: >"$recovery_tree/input.txt" || fail 'recovery input'
missing_command=$work/missing-command
find_missing_record=$work/find-missing.record
"$find_binary" "$recovery_tree" -type f \
  \( -exec "$missing_command" {} \; \
  -o -exec "$helper" record "$find_missing_record" {} \; \) \
  >/dev/null 2>"$work/find-missing.stderr"
status=$?
[ "$status" -eq 0 ] || fail "find missing-command recovery status was $status"
recorded=$(cat "$find_missing_record" 2>/dev/null) || fail 'find did not recover after a missing command'
[ "$recorded" = "$recovery_tree/input.txt" ] || fail 'find recorded the wrong missing-command path'
count=$(wc -l <"$find_missing_record") || fail 'counting missing-command recovery records'
[ "$count" -eq 1 ] || fail 'find recorded an unexpected number of missing-command paths'

find_nonzero_record=$work/find-nonzero.record
"$find_binary" "$recovery_tree" -type f \
  \( -exec "$helper" exit 7 {} \; \
  -o -exec "$helper" record "$find_nonzero_record" {} \; \) \
  >/dev/null 2>"$work/find-nonzero.stderr"
status=$?
[ "$status" -eq 0 ] || fail "find nonzero-command recovery status was $status"
recorded=$(cat "$find_nonzero_record" 2>/dev/null) || fail 'find did not recover after a nonzero command'
[ "$recorded" = "$recovery_tree/input.txt" ] || fail 'find recorded the wrong nonzero-command path'
count=$(wc -l <"$find_nonzero_record") || fail 'counting nonzero-command recovery records'
[ "$count" -eq 1 ] || fail 'find recorded an unexpected number of nonzero-command paths'

printf '%s\000' "$recovery_tree/input.txt" |
  "$xargs_binary" -0 "$missing_command" >/dev/null 2>"$work/xargs-missing.stderr"
status=$?
[ "$status" -eq 127 ] || fail "xargs missing-command status was $status, expected 127"

printf '%s\000' "$recovery_tree/input.txt" |
  "$xargs_binary" -0 "$helper" exit 7 >/dev/null 2>"$work/xargs-nonzero.stderr"
status=$?
[ "$status" -eq 123 ] || fail "xargs nonzero-command status was $status, expected 123"

xargs_recovery_record=$work/xargs-recovery.record
printf '%s\000' "$recovery_tree/input.txt" |
  "$xargs_binary" -0 "$helper" record "$xargs_recovery_record" \
    >/dev/null 2>"$work/xargs-recovery.stderr"
status=$?
[ "$status" -eq 0 ] || fail "xargs recovery status was $status"
[ -s "$xargs_recovery_record" ] || fail 'xargs did not recover after failures'
echo 'find fork: missing/nonzero command status and recovery pass'

rm -rf "$work" || fail 'temporary tree cleanup'
work=
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
