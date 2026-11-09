#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

sqlite3=${SQLITE3:-/bin/sqlite3}
extension=${SQLITE_EXTENSION_PATH:-/plugins/sample.so}
native_reference=${SQLITE_NATIVE_REFERENCE:-0}
workdir=$(mktemp -d /tmp/sqlite3-extension-runtime.XXXXXX)
trap 'rm -rf "$workdir"' EXIT
database=$workdir/extensions.sqlite

fail() {
  printf 'sqlite extension runtime failure: %s\n' "$*" >&2
  exit 1
}

first_sql=$workdir/first.sql
first_output=$workdir/first.out
cat >"$first_sql" <<EOF
.bail on
.load $extension
SELECT wasm_answer(2);
SELECT wasm_state();
SELECT wasm_answer(3);
SELECT wasm_state();
CREATE TABLE extension_result(answer INTEGER NOT NULL, state INTEGER NOT NULL);
INSERT INTO extension_result(answer, state) VALUES (wasm_answer(4), 0);
UPDATE extension_result SET state=wasm_state();
SELECT answer || ':' || state FROM extension_result;
EOF
"$sqlite3" -batch -noheader "$database" <"$first_sql" >"$first_output" ||
  fail "initial .load or callback SQL failed: $(cat "$first_output")"
grep -qx '42' "$first_output" || fail "wasm_answer(2) did not return 42"
printf '%s\n' 'sqlite extension: standard .load registers wasm_answer and returns 42 pass'

grep -qx '1002' "$first_output" || fail "first callback state is wrong"
grep -qx '43' "$first_output" || fail "second wasm_answer call is wrong"
grep -qx '2003' "$first_output" || fail "second callback state is wrong"
grep -qx '44:3004' "$first_output" || fail "third callback state was not stored"
printf '%s\n' 'sqlite extension: repeated API callbacks preserve module data state pass'

reopen_sql=$workdir/reopen.sql
reopen_output=$workdir/reopen.out
cat >"$reopen_sql" <<EOF
.bail on
.load $extension
SELECT answer || ':' || state FROM extension_result;
SELECT wasm_answer(2);
SELECT wasm_state();
EOF
"$sqlite3" -batch -noheader "$database" <"$reopen_sql" >"$reopen_output" ||
  fail "database close/reopen query failed: $(cat "$reopen_output")"
grep -qx '44:3004' "$reopen_output" || fail "extension row did not persist across reopen"
grep -qx '42' "$reopen_output" || fail "extension did not load after database reopen"
grep -qx '1002' "$reopen_output" || fail "extension state did not restart for the reopened process"
printf '%s\n' 'sqlite extension: database survives close and reopen pass'

recovery_sql=$workdir/recovery.sql
recovery_output=$workdir/recovery.out
cat >"$recovery_sql" <<EOF
.load $workdir/missing.so
.load $extension
SELECT wasm_answer(2);
SELECT wasm_state();
EOF
recovery_status=0
if "$sqlite3" -batch -noheader "$database" <"$recovery_sql" >"$recovery_output" 2>&1; then
  recovery_status=0
else
  recovery_status=$?
fi
if [ "$native_reference" = 1 ]; then
  [ "$recovery_status" -le 1 ] || fail "unexpected host sqlite3 status after extension load error: $recovery_status"
else
  [ "$recovery_status" -eq 1 ] || fail "expected target sqlite3 status 1 after extension load error, got $recovery_status"
fi
grep -qi 'error' "$recovery_output" || fail "failed .load did not report its error"
grep -Fq "$workdir/missing.so" "$recovery_output" || fail "load error omitted the missing extension path"
grep -qx '42' "$recovery_output" || fail "valid .load did not recover in the same sqlite3 process"
grep -qx '1002' "$recovery_output" || fail "recovered extension callback state is wrong"
printf '%s\n' 'sqlite extension: failed load reports an error and later load recovers pass'

rm -rf "$workdir"
trap - EXIT
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
