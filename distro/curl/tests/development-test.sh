#!/bin/busybox sh
# SPDX-License-Identifier: MIT

tls_pid=
ca_saved=
cleanup() {
  if [ -n "$tls_pid" ]; then
    kill "$tls_pid" 2>/dev/null || :
    wait "$tls_pid" 2>/dev/null || :
    tls_pid=
  fi
}
restore_ca() {
  if [ -n "$ca_saved" ]; then
    cp "$root/original-ca.pem" "$default_ca" || return 1
    ca_saved=
  fi
}
finish() {
  cleanup
  restore_ca
}
fail() {
  finish || :
  printf 'libcurl application failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}
trap finish EXIT
trap 'finish; exit 1' HUP INT TERM
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
unset CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR
root=/tmp/libcurl-application
default_ca=/etc/ssl/cert.pem
port=9445
mkdir -p "$root" || fail "creating fixture directory"
mount -t proc proc /proc || fail "mounting proc"
ip link set lo up || fail "bringing up loopback"
for license in curl-COPYING integration-MIT zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT example-MIT; do
  test -s "/share/licenses/curl/$license" || fail "missing license: $license"
done

# A real child process must return normally and preserve NUL/high-bit bytes.
printf '\000\001\177\200\377installed-libcurl\000\n' >"$root/input"
timeout -s KILL 15 /bin/libcurl-fetch "file://$root/input" >"$root/body" 2>"$root/error" ||
  fail "binary file transfer did not exit successfully"
cmp "$root/input" "$root/body" || fail "binary callback changed file bytes"
grep -qx 'libcurl response: 0 verify: 0' "$root/error" || fail "missing file result"
echo "libcurl application: binary file callback and normal exit verified"

for identity in server unrelated; do
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -subj "/CN=$identity" -addext subjectAltName=DNS:localhost -days 1 \
    -keyout "$root/$identity.key" -out "$root/$identity.pem" \
    >"$root/keygen-$identity.log" 2>&1 || fail "generating $identity credential"
done
port_hex=$(printf '%04X' "$port")
start_server() {
  cleanup
  openssl s_server -accept "127.0.0.1:$port" -cert "$root/server.pem" \
    -key "$root/server.key" -tls1_3 -www -naccept 1 \
    </dev/null >"$root/server.log" 2>&1 &
  tls_pid=$!
  attempts=0
  while kill -0 "$tls_pid" 2>/dev/null; do
    if awk -v port=":$port_hex" '$2 ~ (port "$") && $4 == "0A" { found = 1 } END { exit !found }' /proc/net/tcp; then
      return
    fi
    attempts=$((attempts + 1))
    [ "$attempts" -lt 100000 ] || fail "TLS socket did not become ready"
  done
  fail "TLS server exited before listening"
}
request() {
  timeout -s KILL 15 /bin/libcurl-fetch "https://$1:$port/" "$2" "$1:$port:127.0.0.1" \
    >"$root/body" 2>"$root/error"
}
expect_transfer() {
  grep -qx 'libcurl response: 200 verify: 0' "$root/error" || fail "HTTP or verification result"
  grep -q s_server "$root/body" || fail "missing HTTPS body"
  cleanup
}
expect_rejection() {
  [ "$status" -eq 60 ] || fail "verification returned $status instead of 60"
  grep -q '^libcurl error: 60 ' "$root/error" || fail "missing verification diagnostic"
  cleanup
}

start_server
request localhost "$root/server.pem" || fail "explicit trust HTTPS request"
expect_transfer
echo "libcurl application: explicit CA TLS1.3 over Linux TCP verified"

test -s "$default_ca" || fail "distribution CA bundle missing"
cp "$default_ca" "$root/original-ca.pem" || fail "saving distribution CA bundle"
ca_saved=1
cp "$root/server.pem" "$default_ca" || fail "installing temporary default trust"
start_server
request localhost - || fail "default trust HTTPS request"
expect_transfer
echo "libcurl application: default CA TLS1.3 verified"

# Correct default trust must not hide a bad explicit CA or bad hostname.
start_server
status=0
request localhost "$root/unrelated.pem" || status=$?
expect_rejection
echo "libcurl application: explicit untrusted CA rejected despite trusted default"

start_server
status=0
request wrong.invalid "$root/server.pem" || status=$?
expect_rejection
grep -Eqi 'subject name|hostname|host name|certificate.*name' "$root/error" || fail "missing hostname diagnostic"
echo "libcurl application: wrong hostname rejected"

restore_ca || fail "restoring distribution CA bundle"
cmp "$root/original-ca.pem" "$default_ca" || fail "restored distribution CA bundle differs"
echo "libcurl application: installed static client, file bytes, TLS trust and normal exits verified"
echo "::vm-test::pass"
while :; do :; done
