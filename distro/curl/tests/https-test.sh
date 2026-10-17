#!/bin/busybox sh
# SPDX-License-Identifier: MIT

tls_pid=
cleanup() {
  if [ -n "$tls_pid" ]; then
    kill "$tls_pid" 2>/dev/null || :
    wait "$tls_pid" 2>/dev/null || :
    tls_pid=
  fi
}
fail() {
  cleanup
  printf 'curl HTTPS failure: %s\n' "$*"
  echo "::vm-test::fail"
  while :; do :; done
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
root=/tmp/curl-tls
port=9443
mkdir -p "$root" || fail "creating fixture directory"
mount -t proc proc /proc || fail "mounting proc"
ip link set lo up || fail "bringing up loopback"
for license in curl-COPYING integration-MIT zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT; do
  test -s "/share/licenses/curl/$license" || fail "missing license: $license"
done
curl --version >"$root/version" 2>&1 || fail "reading curl version"
grep -qi OpenSSL "$root/version" || fail "curl did not select OpenSSL"

# Generate fresh, local-only credentials against the Linux clock. The client
# names an explicit CA file; this profile has no compiled-in CA bundle path.
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
  curl --silent --show-error --noproxy '*' --http1.1 \
    --tlsv1.3 --tls-max 1.3 --connect-timeout 5 --max-time 10 \
    --cacert "$2" --resolve "$1:$port:127.0.0.1" \
    --output "$root/body" --write-out '%{http_code} %{ssl_verify_result}' \
    "https://$1:$port/" >"$root/status" 2>"$root/error"
}

start_server
request localhost "$root/server.pem" || fail "trusted HTTPS transfer"
[ "$(cat "$root/status")" = '200 0' ] || fail "HTTP status or certificate verification result"
grep -q s_server "$root/body" || fail "TLS server response body missing"
cleanup
echo "curl HTTPS: trusted localhost TLS1.3 over Linux TCP verified"

start_server
status=0
request localhost "$root/unrelated.pem" || status=$?
[ "$status" -eq 60 ] || fail "untrusted certificate returned $status instead of 60"
grep -Eqi 'self-signed certificate|unable to get local issuer|certificate verify failed' "$root/error" ||
  fail "missing trust rejection diagnostic"
cleanup
echo "curl HTTPS: untrusted certificate rejected"

start_server
status=0
request wrong.invalid "$root/server.pem" || status=$?
[ "$status" -eq 60 ] || fail "wrong hostname returned $status instead of 60"
grep -Eqi 'subject name|hostname|host name|certificate.*name' "$root/error" ||
  fail "missing hostname rejection diagnostic"
cleanup
echo "curl HTTPS: wrong hostname rejected"

echo "curl: explicit-CA TLS1.3 transfer and certificate/hostname rejection verified"
echo "::vm-test::pass"
while :; do :; done
