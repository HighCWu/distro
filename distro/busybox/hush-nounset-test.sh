#!/bin/sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

shell_program=${HUSH_NOUNSET_PROGRAM:-/bin/busybox}
shell_applet=${HUSH_NOUNSET_APPLET-hush}
watchdog=${HUSH_NOUNSET_WATCHDOG:-/bin/busybox}
watchdog_kind=${HUSH_NOUNSET_WATCHDOG_KIND:-busybox}
native_reference=${HUSH_NOUNSET_NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
    work=
  fi
}

fail() {
  printf 'hush nounset test failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stdout "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'hush nounset diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

run_shell() {
  if [ -n "$shell_applet" ]; then
    if [ "$watchdog_kind" = busybox ]; then
      "$watchdog" timeout -k 1 8 "$shell_program" "$shell_applet" "$@"
    elif [ "$watchdog_kind" = gnu ]; then
      "$watchdog" -k 1 8 "$shell_program" "$shell_applet" "$@"
    else
      fail "invalid watchdog kind: $watchdog_kind"
    fi
  else
    if [ "$watchdog_kind" = busybox ]; then
      "$watchdog" timeout -k 1 8 "$shell_program" "$@"
    elif [ "$watchdog_kind" = gnu ]; then
      "$watchdog" -k 1 8 "$shell_program" "$@"
    else
      fail "invalid watchdog kind: $watchdog_kind"
    fi
  fi
}

run_case() {
  stage=$1
  expected_status=$2
  shift 2
  run_shell "$@" >"$work/$stage.stdout" 2>"$work/$stage.stderr"
  status=$?
  if [ "$expected_status" = error ]; then
    [ "$status" -ne 0 ] || fail "$stage accepted a command expected to fail"
  else
    [ "$status" -eq 0 ] || fail "$stage returned status $status"
  fi
}

check_error() {
  stage=$1
  parameter=$2
  grep -F "$parameter" "$work/$stage.stderr" >/dev/null 2>&1 ||
    fail "$stage diagnostic omitted parameter name $parameter"
  grep -qi 'parameter not set' "$work/$stage.stderr" >/dev/null 2>&1 ||
    fail "$stage diagnostic did not identify an unset parameter"
}

[ -x "$shell_program" ] || fail "shell is not executable: $shell_program"
[ -x "$watchdog" ] || fail "watchdog is not executable: $watchdog"

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

work=$(mktemp -d /tmp/hush-nounset.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

cat >"$work/unset-variable.sh" <<'SCRIPT'
set -eu
unset HUSH_NOUNSET_MISSING
printf 'before unset expansion\n'
: "$HUSH_NOUNSET_MISSING"
printf 'unreachable\n'
SCRIPT
printf 'before unset expansion\n' >"$work/unset-expected.stdout"
run_case unset-variable error "$work/unset-variable.sh"
check_error unset-variable HUSH_NOUNSET_MISSING
cmp "$work/unset-expected.stdout" "$work/unset-variable.stdout" >/dev/null 2>&1 ||
  fail 'unset expansion did not stop before the following command'
echo 'hush nounset: set -eu rejects an unset variable with a diagnostic'

cat >"$work/startup-u.sh" <<'SCRIPT'
unset HUSH_NOUNSET_STARTUP
: "$HUSH_NOUNSET_STARTUP"
printf 'unreachable\n'
SCRIPT
run_case startup-u error -u "$work/startup-u.sh"
check_error startup-u HUSH_NOUNSET_STARTUP
echo 'hush nounset: startup -u option rejects an unset variable'

cat >"$work/empty-variable.sh" <<'SCRIPT'
set -u
HUSH_NOUNSET_EMPTY=
[ -z "$HUSH_NOUNSET_EMPTY" ] || exit 11
printf '<%s>\n' "$HUSH_NOUNSET_EMPTY"
SCRIPT
printf '<>\n' >"$work/empty-expected.stdout"
run_case empty-variable ok "$work/empty-variable.sh"
cmp "$work/empty-expected.stdout" "$work/empty-variable.stdout" >/dev/null 2>&1 ||
  fail 'set empty variable was treated as unset'
echo 'hush nounset: a set empty value remains distinct from an unset variable'

cat >"$work/default-operators.sh" <<'SCRIPT'
set -u
unset HUSH_NOUNSET_DASH HUSH_NOUNSET_COLON_DASH
unset HUSH_NOUNSET_ASSIGN HUSH_NOUNSET_COLON_ASSIGN HUSH_NOUNSET_ALT
HUSH_NOUNSET_EMPTY=
printf '<%s>\n' "${HUSH_NOUNSET_DASH-default}" "${HUSH_NOUNSET_COLON_DASH:-colon-default}" "${HUSH_NOUNSET_ASSIGN=assigned}" "$HUSH_NOUNSET_ASSIGN" "${HUSH_NOUNSET_COLON_ASSIGN:=colon-assigned}" "$HUSH_NOUNSET_COLON_ASSIGN" "${HUSH_NOUNSET_ALT+alternate}" "${HUSH_NOUNSET_DASH:+alternate}" "${HUSH_NOUNSET_EMPTY-default}" "${HUSH_NOUNSET_EMPTY:-colon-empty}" "${HUSH_NOUNSET_EMPTY=must-not-assign}" "$HUSH_NOUNSET_EMPTY" "${HUSH_NOUNSET_EMPTY+is-set}" "${HUSH_NOUNSET_EMPTY:+is-nonempty}"
SCRIPT
cat >"$work/default-expected.stdout" <<'EXPECTED'
<default>
<colon-default>
<assigned>
<assigned>
<colon-assigned>
<colon-assigned>
<>
<>
<>
<colon-empty>
<>
<>
<is-set>
<>
EXPECTED
run_case default-operators ok "$work/default-operators.sh"
cmp "$work/default-expected.stdout" "$work/default-operators.stdout" >/dev/null 2>&1 ||
  fail 'default, assignment, or alternate expansion differed under nounset'
echo 'hush nounset: default, assignment, and alternate operators run before unset checks'

cat >"$work/missing-derived-parameter.sh" <<'SCRIPT'
set -u
unset HUSH_NOUNSET_DERIVED
: "${#HUSH_NOUNSET_DERIVED}"
: "${HUSH_NOUNSET_DERIVED%*}"
printf 'unreachable\n'
SCRIPT
run_case missing-derived-parameter error "$work/missing-derived-parameter.sh"
check_error missing-derived-parameter HUSH_NOUNSET_DERIVED
echo 'hush nounset: length expansion rejects an unset parameter'

cat >"$work/enable-long-option.sh" <<'SCRIPT'
unset HUSH_NOUNSET_OPTION_MISSING
set -o nounset
case $- in *u*) ;; *) exit 21 ;; esac
: "$HUSH_NOUNSET_OPTION_MISSING"
SCRIPT
run_case enable-long-option error "$work/enable-long-option.sh"
check_error enable-long-option HUSH_NOUNSET_OPTION_MISSING

cat >"$work/disable-long-option.sh" <<'SCRIPT'
set -o nounset
case $- in *u*) ;; *) exit 22 ;; esac
set +o nounset
case $- in *u*) exit 23 ;; esac
unset HUSH_NOUNSET_DISABLED
: "$HUSH_NOUNSET_DISABLED"
printf 'long option disabled\n'
SCRIPT
printf 'long option disabled\n' >"$work/disable-long-expected.stdout"
run_case disable-long-option ok "$work/disable-long-option.sh"
cmp "$work/disable-long-expected.stdout" "$work/disable-long-option.stdout" >/dev/null 2>&1 ||
  fail 'set +o nounset did not disable nounset'

cat >"$work/disable-short-option.sh" <<'SCRIPT'
set -u
case $- in *u*) ;; *) exit 24 ;; esac
set +u
case $- in *u*) exit 25 ;; esac
unset HUSH_NOUNSET_DISABLED
: "$HUSH_NOUNSET_DISABLED"
printf 'short option disabled\n'
SCRIPT
printf 'short option disabled\n' >"$work/disable-short-expected.stdout"
run_case disable-short-option ok "$work/disable-short-option.sh"
cmp "$work/disable-short-expected.stdout" "$work/disable-short-option.stdout" >/dev/null 2>&1 ||
  fail 'set +u did not disable nounset'
echo 'hush nounset: set +/-u and set +/-o nounset switch the option and $- state'

cat >"$work/zero-positionals.sh" <<'SCRIPT'
set -u
[ "$#" -eq 0 ] || exit 31
: "$@" "$*"
printf 'zero positional parameters pass\n'
SCRIPT
printf 'zero positional parameters pass\n' >"$work/zero-positionals-expected.stdout"
run_case zero-positionals ok "$work/zero-positionals.sh"
cmp "$work/zero-positionals-expected.stdout" "$work/zero-positionals.stdout" >/dev/null 2>&1 ||
  fail 'zero-argument $@ or $* was rejected by nounset'

cat >"$work/positional-parameters.sh" <<'SCRIPT'
set -u
[ "$#" -eq 2 ] || exit 32
[ "$1" = first ] || exit 33
[ "$2" = second ] || exit 34
case $- in *u*) ;; *) exit 35 ;; esac
: "$0" "$?" "$$"
printf 'positional and special parameters pass\n'
SCRIPT
printf 'positional and special parameters pass\n' >"$work/positional-expected.stdout"
run_case positional-parameters ok "$work/positional-parameters.sh" first second
cmp "$work/positional-expected.stdout" "$work/positional-parameters.stdout" >/dev/null 2>&1 ||
  fail 'set positional or always-defined special parameters changed under nounset'

cat >"$work/missing-positional.sh" <<'SCRIPT'
set -u
: "$3"
printf 'unreachable\n'
SCRIPT
run_case missing-positional error "$work/missing-positional.sh" first second
check_error missing-positional 3

cat >"$work/missing-bang.sh" <<'SCRIPT'
set -u
: "$!"
printf 'unreachable\n'
SCRIPT
run_case missing-bang error "$work/missing-bang.sh"
check_error missing-bang '!'
echo 'hush nounset: positional parameters and the zero-argument special cases follow POSIX rules'

cat >"$work/reexec-options.sh" <<'SCRIPT'
set -u
case $- in *u*) ;; *) exit 41 ;; esac
subshell_flags=$(printf '%s' "$-")
case $subshell_flags in *u*) ;; *) exit 42 ;; esac
(
  case $- in *u*) ;; *) exit 43 ;; esac
)
unset HUSH_NOUNSET_NESTED
substitution=$( : "$HUSH_NOUNSET_NESTED" )
status=$?
[ "$status" -ne 0 ] || exit 44
[ -z "$substitution" ] || exit 45
printf 'nounset inherited by subshell and command substitution\n'
SCRIPT
printf 'nounset inherited by subshell and command substitution\n' >"$work/reexec-expected.stdout"
run_case reexec-options ok "$work/reexec-options.sh"
grep -F HUSH_NOUNSET_NESTED "$work/reexec-options.stderr" >/dev/null 2>&1 ||
  fail 'command substitution did not reject the unset variable'
cmp "$work/reexec-expected.stdout" "$work/reexec-options.stdout" >/dev/null 2>&1 ||
  fail 'nounset option was not inherited by a subshell or command substitution'
echo 'hush nounset: NOMMU re-exec preserves nounset for subshells and command substitutions'

cat >"$work/errexit-contexts.sh" <<'SCRIPT'
set -e
if false; then
  exit 51
fi
false && exit 52
false || :
printf 'errexit conditional contexts pass\n'
SCRIPT
printf 'errexit conditional contexts pass\n' >"$work/errexit-contexts-expected.stdout"
run_case errexit-contexts ok "$work/errexit-contexts.sh"
cmp "$work/errexit-contexts-expected.stdout" "$work/errexit-contexts.stdout" >/dev/null 2>&1 ||
  fail 'existing errexit conditional behavior regressed'
echo 'hush nounset: existing errexit if/and/or contexts still pass'

cleanup
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  echo 'hush nounset host reference passed'
  exit 0
fi
while :; do sleep 1; done
