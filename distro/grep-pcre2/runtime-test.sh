#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
export TZ=UTC
umask 022

grep_program=${GREP_PROGRAM:-/bin/grep}
native_reference=${NATIVE_REFERENCE:-0}
workdir=

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
  fi
}

fail() {
  printf 'grep-pcre2 runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'grep-pcre2 diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

run_grep() {
  label=$1
  shift
  if /bin/busybox timeout 10 "$grep_program" "$@" \
    >"$workdir/$label.stdout" 2>"$workdir/$label.stderr"; then
    status=0
  else
    status=$?
  fi
  case "$status" in
  124 | 137 | 143) fail "$label hit the grep watchdog (status $status)" ;;
  esac
  return "$status"
}

[ -x "$grep_program" ] || fail "GNU grep is not executable: $grep_program"
workdir=$(mktemp -d /tmp/grep-pcre2-runtime.XXXXXX)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$workdir" ] || fail 'creating temporary directory'
trap cleanup EXIT

run_grep version --version || fail 'grep --version failed'
version_output=$(cat "$workdir/version.stdout")
case "$version_output" in
*'GNU grep) 3.11'*) ;;
*) fail "expected GNU grep 3.11: $version_output" ;;
esac
case "$version_output" in
*'uses PCRE2'*) ;;
*) fail 'grep --version does not report PCRE2 support' ;;
esac

printf 'key=abab\nkey=abcd\n' >"$workdir/backreference.input"
status=$?
[ "$status" -eq 0 ] || fail 'writing backreference input'
printf 'key=abab\n' >"$workdir/backreference.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing backreference expected output'
if run_grep backreference -P '(?<=key=)([a-z]{2})\1' "$workdir/backreference.input"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "lookbehind/backreference grep returned $status"
cmp "$workdir/backreference.stdout" "$workdir/backreference.expected" \
  >/dev/null 2>&1 || fail 'lookbehind/backreference output differs'
[ ! -s "$workdir/backreference.stderr" ] || fail 'valid PCRE wrote diagnostics'
printf '%s\n' 'grep-pcre2: lookbehind and backreference matched exact output'

printf 'section\ncaf\303\251\nend\000unrelated\n' >"$workdir/utf.input"
status=$?
[ "$status" -eq 0 ] || fail 'writing UTF-8 multi-line input'
printf 'section\ncaf\303\251\nend\000' >"$workdir/utf.expected"
status=$?
[ "$status" -eq 0 ] || fail 'writing UTF-8 expected output'
if run_grep utf -Pzo '(*UTF)(?s)section\ncaf\x{e9}\nend' "$workdir/utf.input"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "-z UTF-8 multiline grep returned $status"
cmp "$workdir/utf.stdout" "$workdir/utf.expected" >/dev/null 2>&1 ||
  fail '-z UTF-8 multiline output differs'
[ ! -s "$workdir/utf.stderr" ] || fail '-z UTF-8 pattern wrote diagnostics'
printf '%s\n' 'grep-pcre2: -z matched a multi-line UTF-8 code point explicitly in UTF mode'

printf 'key=abac\n' >"$workdir/no-match.input"
status=$?
[ "$status" -eq 0 ] || fail 'writing no-match input'
if run_grep no-match -P '(?<=key=)([a-z]{2})\1' "$workdir/no-match.input"; then
  fail 'no-match pattern returned success'
else
  status=$?
fi
[ "$status" -eq 1 ] || fail "no-match status was $status, expected 1"
[ ! -s "$workdir/no-match.stdout" ] || fail 'no-match pattern produced output'
[ ! -s "$workdir/no-match.stderr" ] || fail 'no-match pattern wrote diagnostics'

if run_grep invalid -P '[' "$workdir/backreference.input"; then
  fail 'invalid PCRE unexpectedly succeeded'
else
  status=$?
fi
[ "$status" -eq 2 ] || fail "invalid PCRE status was $status, expected 2"
[ -s "$workdir/invalid.stderr" ] || fail 'invalid PCRE had no diagnostic'

if run_grep recovery -P '(?<=key=)([a-z]{2})\1' "$workdir/backreference.input"; then
  status=0
else
  status=$?
fi
[ "$status" -eq 0 ] || fail "valid PCRE did not recover after errors (status $status)"
cmp "$workdir/recovery.stdout" "$workdir/backreference.expected" \
  >/dev/null 2>&1 || fail 'recovery PCRE output differs'
[ ! -s "$workdir/recovery.stderr" ] || fail 'recovery PCRE wrote diagnostics'
printf '%s\n' 'grep-pcre2: match/no-match/invalid statuses and recovery verified'

cleanup
workdir=
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
