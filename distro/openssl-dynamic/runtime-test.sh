#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

native_reference=${NATIVE_REFERENCE:-0}
openssl_program=${OPENSSL_DYNAMIC_OPENSSL:-/opt/openssl-dynamic/bin/openssl}
runtime_program=${OPENSSL_DYNAMIC_RUNTIME_PROGRAM:-/opt/openssl-dynamic/bin/provider-runtime}
modules_directory=${OPENSSL_DYNAMIC_MODULES:-}
workdir=
timeout_program=

cleanup() {
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
    workdir=
  fi
}

fail() {
  printf 'OpenSSL dynamic runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.out "$workdir"/*.err; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'OpenSSL dynamic diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

case "$native_reference" in
0)
  openssl_program=${OPENSSL_DYNAMIC_OPENSSL:-/opt/openssl-dynamic/bin/openssl}
  runtime_program=${OPENSSL_DYNAMIC_RUNTIME_PROGRAM:-/opt/openssl-dynamic/bin/provider-runtime}
  modules_directory=${OPENSSL_DYNAMIC_MODULES:-/opt/openssl-dynamic/lib/ossl-modules}
  export OPENSSL_MODULES="$modules_directory"
  export OPENSSL_CONF=/opt/openssl-dynamic/ssl/openssl.cnf
  timeout_program=/bin/busybox
  ;;
1)
  openssl_program=${OPENSSL_DYNAMIC_OPENSSL:-openssl}
  runtime_program=${OPENSSL_DYNAMIC_RUNTIME_PROGRAM:-}
  unset OPENSSL_CONF
  if [ -n "$modules_directory" ]; then
    export OPENSSL_MODULES="$modules_directory"
  fi
  timeout_program=$(command -v timeout)
  [ -n "$timeout_program" ] || fail 'host timeout command is unavailable'
  ;;
*)
  fail "invalid NATIVE_REFERENCE=$native_reference"
  ;;
esac

if [ "$native_reference" = 0 ]; then
  run_timed() { "$timeout_program" timeout 20 "$@"; }
else
  run_timed() { "$timeout_program" 20 "$@"; }
fi

openssl_program=$(command -v "$openssl_program")
status=$?
if [ "$status" -ne 0 ] || [ -z "$openssl_program" ]; then
  fail "OpenSSL CLI was not found: ${OPENSSL_DYNAMIC_OPENSSL:-openssl}"
fi
[ -x "$openssl_program" ] || fail "OpenSSL CLI is not executable: $openssl_program"
if [ -n "$runtime_program" ]; then
  [ -x "$runtime_program" ] || fail "provider consumer is not executable: $runtime_program"
fi

workdir=$(mktemp -d /tmp/openssl-dynamic-runtime.XXXXXX)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$workdir" ] || fail 'creating temporary directory'
trap cleanup EXIT

run_timed "$openssl_program" version >"$workdir/version.out" 2>"$workdir/version.err"
status=$?
[ "$status" -eq 0 ] || fail "openssl version failed (status $status)"
IFS= read -r version <"$workdir/version.out"
if [ "$native_reference" != 1 ]; then
  case "$version" in
  "OpenSSL 3.5.7"*) ;;
  *) fail "unexpected OpenSSL version: $version" ;;
  esac
  [ -s "$OPENSSL_CONF" ] || fail "OpenSSL configuration is missing: $OPENSSL_CONF"
fi

run_timed "$openssl_program" version -m >"$workdir/modules.out" 2>"$workdir/modules.err"
status=$?
[ "$status" -eq 0 ] || fail "openssl version -m failed (status $status)"
if [ "$native_reference" != 1 ]; then
  grep -Fx 'MODULESDIR: "/opt/openssl-dynamic/lib/ossl-modules"' \
    "$workdir/modules.out" >/dev/null || fail 'OpenSSL reported an unexpected module directory'
fi

run_timed "$openssl_program" list -providers -provider legacy -provider default \
  >"$workdir/providers.out" 2>"$workdir/providers.err"
status=$?
[ "$status" -eq 0 ] || fail "loading legacy/default providers failed (status $status)"
grep -Eq '^[[:space:]]*legacy([[:space:]]|$)' "$workdir/providers.out" ||
  fail 'the CLI did not list the legacy provider'
grep -Eq '^[[:space:]]*default([[:space:]]|$)' "$workdir/providers.out" ||
  fail 'the CLI did not list the default provider'

if run_timed "$openssl_program" list -providers -provider \
  linux-wasm-provider-that-does-not-exist >"$workdir/missing.out" 2>"$workdir/missing.err"; then
  fail 'the CLI unexpectedly loaded a missing provider'
else
  status=$?
fi
[ "$status" -ne 124 ] || fail 'missing-provider command timed out'
[ -s "$workdir/missing.err" ] || fail 'missing-provider failure had no diagnostic'

printf 'abc' >"$workdir/message"
run_timed "$openssl_program" dgst -provider legacy -provider default -md4 \
  "$workdir/message" >"$workdir/digest.out" 2>"$workdir/digest.err"
status=$?
[ "$status" -eq 0 ] || fail "CLI MD4 failed after provider recovery (status $status)"
grep -E -i '= ?a448017aaf21d8525fc10ae87aa6729d$' "$workdir/digest.out" >/dev/null ||
  fail 'CLI MD4 returned an unexpected digest'

if [ -n "$runtime_program" ]; then
  run_timed "$runtime_program" >"$workdir/consumer.out" 2>"$workdir/consumer.err"
  status=$?
  [ "$status" -eq 0 ] || fail "OSSL_PROVIDER_load consumer failed (status $status)"
  cat >"$workdir/expected.out" <<'EOF'
openssl dynamic: missing provider rejected and error queue cleared
openssl dynamic: legacy/default loaded; MD4 and SHA-256 verified
openssl dynamic: both providers unloaded
EOF
  if ! cmp -s "$workdir/expected.out" "$workdir/consumer.out"; then
    fail 'provider consumer phase markers were missing or out of order'
  fi
  [ ! -s "$workdir/consumer.err" ] || fail 'provider consumer wrote unexpected error output'
  cat "$workdir/consumer.out" || fail 'reading provider consumer output'
fi

cat "$workdir/digest.out" || fail 'reading OpenSSL CLI digest'
cleanup
trap - EXIT
if [ "$native_reference" = 1 ]; then
  echo "OpenSSL dynamic native reference ($version): provider failure, recovery and MD4 passed"
  exit 0
fi
echo 'OpenSSL dynamic: standard legacy/default provider path and recovery passed'
echo '::vm-test::pass'
while :; do sleep 1; done
