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
  printf 'curl HTTPS failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}
trap finish EXIT
trap 'finish; exit 1' HUP INT TERM
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
root=/tmp/curl-tls
port=9443
default_ca=/etc/ssl/cert.pem
# Do not let inherited client/SSL overrides turn a default-path check into an
# environment-selected trust test. The initramfs and its CA edits are disposable.
unset CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR
mkdir -p "$root" || fail "creating fixture directory"
mount -t proc proc /proc || fail "mounting proc"
ip link set lo up || fail "bringing up loopback"
for license in curl-COPYING integration-MIT zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/curl/$license" || fail "missing license: $license"
done
curl --version >"$root/version" 2>&1 || fail "reading curl version"
grep -qi OpenSSL "$root/version" || fail "curl did not select OpenSSL"
test -s "$default_ca" || fail "distribution CA bundle missing"
[ "$(curl-config --ca)" = "$default_ca" ] || fail "wrong compiled default CA bundle"
cp "$default_ca" "$root/original-ca.pem" || fail "saving default CA bundle"
ca_saved=1

# Generate fresh, local-only credentials against the Linux clock. Never add
# these fixture authorities to a persistent or externally distributed CA bundle.
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
    [ "$attempts" -lt 100000 ] || fail "TLS listening socket did not become ready"
  done
  fail "TLS server exited before listening"
}
request() {
  hostname=$1
  shift
  curl --silent --show-error --noproxy '*' --http1.1 \
    --tlsv1.3 --tls-max 1.3 --connect-timeout 5 --max-time 10 \
    "$@" --resolve "$hostname:$port:127.0.0.1" \
    --output "$root/body" --write-out '%{http_code} %{ssl_verify_result}' \
    "https://$hostname:$port/" >"$root/status" 2>"$root/error"
}
expect_trust_rejection() {
  [ "$status" -eq 60 ] || fail "untrusted certificate returned $status instead of 60"
  grep -Eqi 'self-signed certificate|unable to get local issuer|certificate verify failed' "$root/error" ||
    fail "missing trust rejection diagnostic"
  cleanup
}
expect_transfer() {
  [ "$(cat "$root/status")" = '200 0' ] || fail "HTTP status or certificate verification result"
  grep -q s_server "$root/body" || fail "TLS server response body missing"
  cleanup
}

start_server
status=0
request localhost || status=$?
expect_trust_rejection
echo "curl HTTPS: distribution CA bundle rejects local self-signed certificate"

cp "$root/server.pem" "$default_ca" || fail "installing temporary default trust"
start_server
request localhost || fail "default-CA HTTPS transfer"
expect_transfer
echo "curl HTTPS: default CA bundle trusted localhost TLS1.3 over Linux TCP verified"

cp "$root/unrelated.pem" "$default_ca" || fail "installing unrelated default trust"
start_server
status=0
request localhost || status=$?
expect_trust_rejection
echo "curl HTTPS: unrelated default CA rejected"

start_server
request localhost --cacert "$root/server.pem" || fail "explicit CA override of unrelated default"
expect_transfer
echo "curl HTTPS: trusted localhost TLS1.3 over Linux TCP verified"

cp "$root/server.pem" "$default_ca" || fail "installing trusted default for explicit rejection"
start_server
status=0
request localhost --cacert "$root/unrelated.pem" || status=$?
expect_trust_rejection
echo "curl HTTPS: untrusted certificate rejected"

start_server
status=0
request wrong.invalid --cacert "$root/server.pem" || status=$?
[ "$status" -eq 60 ] || fail "wrong hostname returned $status instead of 60"
grep -Eqi 'subject name|hostname|host name|certificate.*name' "$root/error" ||
  fail "missing hostname rejection diagnostic"
cleanup
echo "curl HTTPS: wrong hostname rejected"

rm "$default_ca" || fail "removing temporary default trust"
start_server
status=0
request localhost || status=$?
[ "$status" -eq 77 ] || fail "missing CA bundle returned $status instead of 77"
cleanup
echo "curl HTTPS: missing default CA bundle fails closed"
restore_ca || fail "restoring distribution CA bundle"
cmp "$root/original-ca.pem" "$default_ca" || fail "restored CA bundle differs"
echo "curl HTTPS: original distribution CA bundle restored"

echo "curl: explicit-CA TLS1.3 transfer and certificate/hostname rejection verified"
echo "::vm-test::pass"
while :; do :; done
