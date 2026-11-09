#!/bin/sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

gawk_program=${GAWK_DYNAMIC_PROGRAM:-/bin/gawk-dynamic}
extension=${GAWK_DYNAMIC_EXTENSION:-/lib/gawk-dynamic/wasmext.so}
bad_extension=${GAWK_DYNAMIC_BAD_EXTENSION:-/lib/gawk-dynamic/badext.so}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'gawk dynamic runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stderr "$work"/*.stdout; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'gawk dynamic diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

[ -x "$gawk_program" ] || fail "gawk is not executable: $gawk_program"
[ -r "$extension" ] || fail "gawk extension is not readable: $extension"
[ -r "$bad_extension" ] || fail "bad gawk extension is not readable: $bad_extension"

version=$("$gawk_program" --version 2>/dev/null)
status=$?
if [ "$status" -ne 0 ]; then
  fail "gawk --version failed (status $status)"
fi
case "$version" in
*"GNU Awk"*) ;;
*) fail 'expected GNU Awk' ;;
esac

work=$(mktemp -d /tmp/gawk-dynamic-runtime.XXXXXX 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$work" ]; then
  fail 'creating temporary directory'
fi
trap cleanup 0

# Load the extension and check both its setup scalar and string callback.
first_program=$work/first.awk
cat >"$first_program" <<'AWK'
BEGIN {
  if (WASM_EXT_READY != "ready")
    exit 11
  print WASM_EXT_READY
  print wasm_ext_echo("alpha")
}
AWK
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing first awk program'
fi
"$gawk_program" -l "$extension" -f "$first_program" \
  >"$work/first.stdout" 2>"$work/first.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "loading extension or calling its string function (status $status)"
fi
printf '%s\n' 'ready' 'value:alpha' >"$work/first.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing first expected output'
fi
cmp "$work/first.expected" "$work/first.stdout" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'extension setup scalar or string function returned the wrong value'
fi
echo 'gawk dynamic: extension load scalar and string callback pass'

# Pass an awk array through the extension and invoke both callbacks repeatedly.
second_program=$work/second.awk
cat >"$second_program" <<'AWK'
BEGIN {
  values["before"] = "kept"
  first_array = wasm_ext_array(values)
  first_string = wasm_ext_echo("first")
  second_array = wasm_ext_array(values)
  second_string = wasm_ext_echo("second")
  if (WASM_EXT_READY != "ready" ||
      first_array != 1 ||
      second_array != 1 ||
      values["extension"] != "ready" ||
      values["before"] != "kept" ||
      first_string != "value:first" ||
      second_string != "value:second")
    exit 21
  print values["extension"]
  print first_array
  print second_array
  print first_string
  print second_string
}
AWK
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing callback program'
fi
"$gawk_program" -l "$extension" -f "$second_program" \
  >"$work/second.stdout" 2>"$work/second.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "array or repeated extension callback failed (status $status)"
fi
printf '%s\n' 'ready' '1' '1' 'value:first' 'value:second' \
  >"$work/second.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing callback expected output'
fi
cmp "$work/second.expected" "$work/second.stdout" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'array mutation or repeated callback results were incorrect'
fi
echo 'gawk dynamic: array arguments and repeated callbacks pass'

# A shared object missing the required dl_load entry point must fail before
# BEGIN starts; diagnostics identify that loader failure explicitly.
bad_program=$work/bad.awk
cat >"$bad_program" <<'AWK'
BEGIN {
  print "GAWK_BAD_BEGIN_RAN"
}
AWK
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing bad-extension awk program'
fi
"$gawk_program" -l "$bad_extension" -f "$bad_program" \
  >"$work/bad.stdout" 2>"$work/bad.stderr"
bad_status=$?
if [ "$bad_status" -eq 0 ]; then
  fail 'gawk accepted an extension without dl_load'
fi
grep -F 'dl_load' "$work/bad.stderr" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'bad extension failure did not identify the missing dl_load entry point'
fi
grep -F 'GAWK_BAD_BEGIN_RAN' "$work/bad.stdout" "$work/bad.stderr" \
  >/dev/null 2>&1
status=$?
if [ "$status" -eq 0 ]; then
  fail 'BEGIN ran despite the extension load failure'
elif [ "$status" -ne 1 ]; then
  fail 'checking whether BEGIN ran after the extension load failure'
fi
echo 'gawk dynamic: missing loader entry point fails before BEGIN pass'

# Start a fresh gawk process after the failed load and verify normal recovery.
recovery_program=$work/recovery.awk
cat >"$recovery_program" <<'AWK'
BEGIN {
  if (WASM_EXT_READY != "ready")
    exit 31
  print wasm_ext_echo("recovered")
}
AWK
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing recovery awk program'
fi
recovery_extension=$extension
if [ "$native_reference" != 1 ]; then
  unset AWKLIBPATH
  recovery_extension=wasmext
fi
"$gawk_program" -l "$recovery_extension" -f "$recovery_program" \
  >"$work/recovery.stdout" 2>"$work/recovery.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "fresh gawk process did not recover with the valid extension (status $status)"
fi
printf '%s\n' 'value:recovered' >"$work/recovery.expected"
status=$?
if [ "$status" -ne 0 ]; then
  fail 'writing recovery expected output'
fi
cmp "$work/recovery.expected" "$work/recovery.stdout" >/dev/null 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  fail 'fresh gawk process returned the wrong recovery result'
fi
echo 'gawk dynamic: fresh process recovers after failed extension load pass'

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
