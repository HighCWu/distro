#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

native_reference=${NATIVE_REFERENCE:-0}
program=${LIBEVENT_RUNTIME_PROGRAM:-/bin/libevent-runtime}
workdir=
loopback_up=0
timeout_program=

cleanup() {
  if [ "$loopback_up" -eq 1 ]; then
    /bin/busybox ifconfig lo down >/dev/null 2>&1 || true
    loopback_up=0
  fi
  if [ -n "$workdir" ]; then
    rm -rf "$workdir"
    workdir=
  fi
}

fail() {
  printf 'libevent runtime failure: %s\n' "$*" >&2
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    for diagnostic in "$workdir"/*.out "$workdir"/*.err; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'libevent runtime diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

trap cleanup EXIT

case "$native_reference" in
0)
  mount -t devtmpfs devtmpfs /dev || fail 'mounting devtmpfs'
  mount -t proc proc /proc || fail 'mounting proc'
  /bin/busybox ifconfig lo 127.0.0.1 up || fail 'bringing up loopback'
  loopback_up=1
  timeout_program=/bin/busybox
  ;;
1)
  timeout_program=$(command -v timeout)
  [ -n "$timeout_program" ] || fail 'host timeout command is unavailable'
  ;;
*)
  fail "invalid NATIVE_REFERENCE=$native_reference"
  ;;
esac

[ -x "$program" ] || fail "program is not executable: $program"
workdir=$(mktemp -d /tmp/libevent-runtime.XXXXXX)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$workdir" ] || fail 'creating temporary directory'

if [ "$native_reference" = 1 ]; then
  "$timeout_program" 15 "$program" >"$workdir/program.out" 2>"$workdir/program.err"
else
  "$timeout_program" timeout 15 "$program" >"$workdir/program.out" 2>"$workdir/program.err"
fi
status=$?
[ "$status" -eq 0 ] || fail "consumer did not finish under the watchdog (status $status)"

cat >"$workdir/expected.out" <<'EOF'
libevent: epoll backend selected
libevent: loopback TCP bufferevent binary echo and close ok
libevent: SIGUSR1 signal event ok
libevent: short timer event ok
libevent: event_base cleanup left no pending events
EOF
if ! cmp -s "$workdir/expected.out" "$workdir/program.out"; then
  fail 'consumer phase markers were missing, duplicated, or out of order'
fi
[ ! -s "$workdir/program.err" ] || fail 'consumer wrote unexpected error output'

cat "$workdir/program.out" || fail 'reading consumer phase markers'
cleanup
trap - EXIT
if [ "$native_reference" = 1 ]; then
  echo 'libevent native reference passed'
  exit 0
fi
echo '::vm-test::pass'
while :; do sleep 1; done
