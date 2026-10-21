#!/bin/busybox sh
# SPDX-License-Identifier: MIT

server_pid=
fail() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || :
  printf '::vm-test::fail: busybox ipv6: %s\n' "$*"
  while :; do :; done
}
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY
mount -t proc proc /proc || fail "mount proc"
ip link set lo up || fail "loopback up"
mkdir -p /tmp/ipv6-www || fail "document root"
printf 'IPv6 HTTP content\n' >/tmp/ipv6-www/index.html || fail "HTTP fixture"
httpd -f -p '[::1]:18086' -h /tmp/ipv6-www &
server_pid=$!
attempt=0
while ! awk '$2 == "00000000000000000000000001000000:46A6" && $4 == "0A" { found=1 } END { exit !found }' /proc/net/tcp6; do
  kill -0 "$server_pid" 2>/dev/null || fail "HTTP server exited before listening"
  attempt=$((attempt + 1))
  [ "$attempt" -lt 200 ] || fail "IPv6 listener deadline"
  sleep 0.05
done
echo 'busybox ipv6: httpd binds actual IPv6 loopback listener pass'
wget -q -O /tmp/ipv6-download 'http://[::1]:18086/index.html' || fail "IPv6 wget"
grep -qx 'IPv6 HTTP content' /tmp/ipv6-download || fail "downloaded content"
printf 'GET /index.html HTTP/1.0\r\n\r\n' | nc -w 2 ::1 18086 >/tmp/ipv6-response || fail "IPv6 nc"
grep -q 'IPv6 HTTP content' /tmp/ipv6-response || fail "nc response"
kill "$server_pid" || fail "stop server"
wait "$server_pid"
status=$?
case "$status" in
0 | 143) ;;
*) fail "server wait returned $status" ;;
esac
server_pid=
rm /tmp/ipv6-www/index.html /tmp/ipv6-download /tmp/ipv6-response || fail "remove files"
rmdir /tmp/ipv6-www || fail "remove document root"
echo 'busybox ipv6: wget and nc fetch HTTP over IPv6, server reap and cleanup pass'
echo '::vm-test::pass'
while :; do :; done
