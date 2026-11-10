#!/bin/sh
# SPDX-License-Identifier: MIT

host_path=${PATH:-}
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
native_reference=${NATIVE_REFERENCE:-0}
openssl_program=
openssl=
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'OpenSSL fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stdout "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'OpenSSL fork diagnostic (%s):\n' "$diagnostic" >&2
        tail -n 40 "$diagnostic" >&2
      fi
    done
  fi
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  while :; do sleep 1; done
}

case "$native_reference" in
0)
  openssl_program=${OPENSSL_FORK_PROGRAM:-/opt/openssl-fork/bin/openssl}
  export OPENSSL_CONF=/opt/openssl-fork/ssl/openssl.cnf
  ;;
1)
  openssl_program=${OPENSSL_FORK_PROGRAM:-openssl}
  unset OPENSSL_CONF
  if [ -z "${OPENSSL_FORK_PROGRAM:-}" ]; then
    PATH=$host_path
    openssl=$(command -v "$openssl_program")
    export PATH=/bin:/sbin:/usr/bin:/usr/sbin
  fi
  ;;
*)
  printf 'OpenSSL fork runtime failure: invalid NATIVE_REFERENCE=%s\n' "$native_reference" >&2
  exit 2
  ;;
esac
if [ -z "$openssl" ]; then
  openssl=$(command -v "$openssl_program")
  status=$?
  if [ "$status" -ne 0 ] || [ -z "$openssl" ]; then
    fail "OpenSSL CLI was not found: $openssl_program"
  fi
fi

if [ ! -x "$openssl" ]; then
  fail "OpenSSL CLI is not executable: $openssl"
fi
if [ "$native_reference" != 1 ] && [ ! -s "$OPENSSL_CONF" ]; then
  fail "OpenSSL configuration is missing: $OPENSSL_CONF"
fi

work=$(mktemp -d /tmp/openssl-fork-runtime.XXXXXX 2>/dev/null)
status=$?
if [ "$status" -ne 0 ] || [ -z "$work" ]; then
  fail 'creating temporary directory'
fi
trap cleanup 0

"$openssl" version >"$work/version.stdout" 2>"$work/version.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "openssl version failed (status $status)"
fi
IFS= read -r version <"$work/version.stdout"
if [ "$native_reference" != 1 ]; then
  case "$version" in
  "OpenSSL 3.5.7"*) ;;
  *) fail "unexpected OpenSSL version: $version" ;;
  esac

  "$openssl" version -d >"$work/directory.stdout" 2>"$work/directory.stderr"
  status=$?
  if [ "$status" -ne 0 ]; then
    fail "openssl version -d failed (status $status)"
  fi
  grep -Fx 'OPENSSLDIR: "/opt/openssl-fork/ssl"' "$work/directory.stdout" >/dev/null ||
    fail 'OpenSSL reported an unexpected configuration directory'
fi

# Keep this workload single-threaded before it forks: its only concurrency is
# OpenSSL speed's two worker processes. The external timeout bounds broken
# signal/timer behavior independently of speed's own one-second SIGALRM.
/bin/busybox timeout 30 "$openssl" speed -multi 2 -elapsed -seconds 1 -bytes 64 sha256 \
  >"$work/speed.stdout" 2>"$work/speed.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "openssl speed did not finish successfully under the watchdog (status $status)"
fi

for worker in 0 1; do
  grep -Fx "Forked child $worker" "$work/speed.stdout" >/dev/null ||
    fail "speed did not start worker $worker"
  grep -E "^Got: \+F:[0-9]+:sha256:[0-9]+([.][0-9]+)? from $worker$" \
    "$work/speed.stdout" >/dev/null || fail "speed did not receive worker $worker's result"
done
timer_count=$(grep -E -c '^\+DT:sha256:1:64$' "$work/speed.stderr")
[ "$timer_count" -eq 2 ] || fail "expected two one-second timer completions, got $timer_count"
awk -F: '
  $1 == "+R" && $3 == "sha256" {
    count++
    if ($2 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+([.][0-9]+)?$/ || ($4 + 0) < 0.5)
      invalid = 1
  }
  END {
    if (count != 2 || invalid)
      exit 1
  }
' "$work/speed.stderr" || fail 'expected two hash results with at least 0.5 seconds elapsed each'
grep -E '^sha256[[:space:]]' "$work/speed.stdout" >/dev/null ||
  fail 'the parent did not print the completed SHA-256 summary'

printf 'abc' >"$work/message"
want=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
"$openssl" dgst -sha256 -r "$work/message" >"$work/digest.stdout" 2>"$work/digest.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "ordinary SHA-256 digest failed (status $status)"
fi
IFS= read -r digest <"$work/digest.stdout"
digest=${digest%% *}
[ "$digest" = "$want" ] || fail "ordinary SHA-256 mismatch: got $digest"

"$openssl" rand -hex 16 >"$work/rand.stdout" 2>"$work/rand.stderr"
status=$?
if [ "$status" -ne 0 ]; then
  fail "ordinary entropy request failed (status $status)"
fi
IFS= read -r random_hex <"$work/rand.stdout"
case "$random_hex" in
*[!0-9a-f]*) fail 'openssl rand returned a non-hexadecimal byte' ;;
esac
[ "${#random_hex}" -eq 32 ] ||
  fail "openssl rand returned ${#random_hex} hex digits instead of 32"

if [ "$native_reference" = 1 ]; then
  echo "OpenSSL native reference ($version): both timed workers, parent completion, digest and entropy passed"
  exit 0
fi

echo 'OpenSSL fork: both timed workers, parent completion, digest and entropy passed'
echo '::vm-test::pass'
while :; do sleep 1; done
