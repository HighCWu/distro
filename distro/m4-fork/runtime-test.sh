#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

set -u
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

m4_program=${M4_FORK_PROGRAM:-/bin/m4-fork}
watchdog=${M4_FORK_WATCHDOG:-/bin/busybox}
watchdog_kind=${M4_FORK_WATCHDOG_KIND:-busybox}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'm4 fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr "$work"/*.stdout; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'm4 fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
        tail -n 20 "$diagnostic" >&2
      fi
    done
  fi
  cleanup
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  exit 1
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devtmpfs (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount proc (status $status)"
fi

[ -x "$m4_program" ] || fail "m4 is not executable: $m4_program"
[ -x "$watchdog" ] || fail "outer watchdog is not executable: $watchdog"
case "$watchdog_kind" in
busybox)
  "$watchdog" timeout -k 1 2 /bin/busybox true >/dev/null 2>&1
  status=$?
  ;;
gnu)
  "$watchdog" -k 1 2 /bin/true >/dev/null 2>&1
  status=$?
  ;;
*)
  fail "invalid watchdog kind: $watchdog_kind"
  ;;
esac
[ "$status" -eq 0 ] || fail "outer watchdog is unavailable (status $status)"

work=$(mktemp -d /tmp/m4-fork.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

run_watchdog() {
  if [ "$watchdog_kind" = busybox ]; then
    "$watchdog" timeout -k 1 12 "$@"
  else
    "$watchdog" -k 1 12 "$@"
  fi
}

run_m4() {
  stage=$1
  side_effect=$2
  shift 2
  if [ -n "$side_effect" ]; then
    (
      cd "$work" || exit 1
      M4_SIDE_EFFECT=$side_effect run_watchdog "$m4_program" "$@"
    ) >"$work/$stage.stdout" 2>"$work/$stage.stderr"
  else
    (
      cd "$work" || exit 1
      run_watchdog "$m4_program" "$@"
    ) >"$work/$stage.stdout" 2>"$work/$stage.stderr"
  fi
}

run_m4 version '' --version
status=$?
[ "$status" -eq 0 ] || fail "m4 --version returned $status"
grep -F 'GNU M4' "$work/version.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'candidate is not GNU M4'
echo 'm4 fork: GNU M4 executable and outer watchdog pass'

mkdir -p "$work/nested"
status=$?
[ "$status" -eq 0 ] || fail 'creating nested include directory'
cat >"$work/nested/leaf.m4" <<'M4'
define(`INNER', `beta')dnl
define(`DEEP', `gamma')dnl
M4
status=$?
[ "$status" -eq 0 ] || fail 'writing leaf include'
cat >"$work/nested/child.m4" <<'M4'
include(`nested/leaf.m4')dnl
divert(1)dnl
nested: INNER/DEEP
divert(0)dnl
M4
status=$?
[ "$status" -eq 0 ] || fail 'writing nested include'
cat >"$work/macros.m4" <<'M4'
define(`WRAP', `<$1>')dnl
divert(-1)dnl
discarded diversion text
divert(1)dnl
include(`nested/child.m4')dnl
divert(0)dnl
macro: WRAP(`alpha')
undivert(1)dnl
tail
M4
status=$?
[ "$status" -eq 0 ] || fail 'writing macro/include/diversion input'
run_m4 macros '' macros.m4
status=$?
[ "$status" -eq 0 ] || fail "macro/include/diversion m4 returned $status"
printf '%s\n' 'macro: <alpha>' 'nested: beta/gamma' 'tail' >"$work/macros.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing macro/include/diversion expectation'
cmp "$work/macros.expected" "$work/macros.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'macro, nested include, or diversion output changed'
echo 'm4 fork: macro expansion, nested include, diversion, and exact output pass'

cat >"$work/syscmd.m4" <<'M4'
syscmd(`printf "%s\n" "syscmd-created-this-file" > "$M4_SIDE_EFFECT"; exit 23')dnl
syscmd_status=sysval
M4
status=$?
[ "$status" -eq 0 ] || fail 'writing syscmd input'
run_m4 syscmd "$work/syscmd.effect" syscmd.m4
status=$?
[ "$status" -eq 0 ] || fail "syscmd m4 returned $status"
printf '%s\n' 'syscmd_status=23' >"$work/syscmd.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing syscmd expectation'
cmp "$work/syscmd.expected" "$work/syscmd.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'syscmd did not propagate its specified nonzero status'
printf '%s\n' 'syscmd-created-this-file' >"$work/syscmd.effect.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing syscmd side-effect expectation'
cmp "$work/syscmd.effect.expected" "$work/syscmd.effect" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'syscmd did not write the expected file contents'
echo 'm4 fork: syscmd executes, writes a file, and exposes status 23 pass'

cat >"$work/esyscmd.m4" <<'M4'
define(`RECOVER', `ok:$1')dnl
esyscmd(`printf "first:%s\nsecond:%s\n" alpha beta | tr "[:lower:]" "[:upper:]"')dnl
esyscmd(`m4_fork_missing_command_7d3a1')dnl
missing_status=sysval
RECOVER(`after-failure')
esyscmd(`printf "recovered:%s\n" after-missing')dnl
recovered_status=sysval
M4
status=$?
[ "$status" -eq 0 ] || fail 'writing esyscmd input'
run_m4 esyscmd '' esyscmd.m4
status=$?
[ "$status" -eq 0 ] || fail "esyscmd m4 returned $status"
printf '%s\n' \
  'FIRST:ALPHA' \
  'SECOND:BETA' \
  'missing_status=127' \
  'ok:after-failure' \
  'recovered:after-missing' \
  'recovered_status=0' >"$work/esyscmd.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing esyscmd expectation'
cmp "$work/esyscmd.expected" "$work/esyscmd.stdout" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'esyscmd output, failure status, or subsequent recovery changed'
grep -F 'm4_fork_missing_command_7d3a1' "$work/esyscmd.stderr" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'missing esyscmd command did not report its shell error'
echo 'm4 fork: esyscmd pipeline output and recovery after missing command pass'

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
