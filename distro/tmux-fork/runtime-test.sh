#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

native_reference=${NATIVE_REFERENCE:-0}
tmux_program=${TMUX_FORK_PROGRAM:-/opt/tmux-fork/bin/tmux}
watchdog=${TMUX_FORK_WATCHDOG:-/bin/busybox}
watchdog_kind=${TMUX_FORK_WATCHDOG_KIND:-busybox}
work=
socket_name=
socket_path=
server_pid=
session_name=

server_process_alive() {
  [ -n "$server_pid" ] || return 1
  [ -n "$socket_name" ] || return 1
  [ -r "/proc/$server_pid/cmdline" ] || return 1
  tr '\000' ' ' <"/proc/$server_pid/cmdline" | grep -F "$socket_name" >/dev/null 2>&1
}

cleanup() {
  if [ -n "$socket_name" ] && [ -x "$tmux_program" ]; then
    if [ "$watchdog_kind" = busybox ]; then
      "$watchdog" timeout -k 1 3 "$tmux_program" -L "$socket_name" \
        -f /dev/null kill-server >/dev/null 2>&1 || true
    else
      "$watchdog" -k 1 3 "$tmux_program" -L "$socket_name" \
        -f /dev/null kill-server >/dev/null 2>&1 || true
    fi
    if server_process_alive; then
      kill -TERM "$server_pid" 2>/dev/null || true
      tries=0
      while server_process_alive; do
        tries=$((tries + 1))
        [ "$tries" -lt 3 ] || break
        sleep 1
      done
      if server_process_alive; then
        kill -KILL "$server_pid" 2>/dev/null || true
      fi
    fi
    socket_name=
  fi
  if [ -n "$work" ]; then
    rm -rf "$work"
    work=
  fi
}

fail() {
  printf 'tmux fork runtime failure: %s\n' "$*" >&2
  if [ -n "$work" ] && [ -d "$work" ]; then
    for diagnostic in "$work"/*.stdout "$work"/*.stderr; do
      if [ -f "$diagnostic" ] && [ -s "$diagnostic" ]; then
        printf 'tmux fork diagnostic (%s):\n' "${diagnostic##*/}" >&2
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

watchdog_run() {
  if [ "$watchdog_kind" = busybox ]; then
    "$watchdog" timeout -k 1 8 "$tmux_program" -L "$socket_name" \
      -f /dev/null "$@"
  else
    "$watchdog" -k 1 8 "$tmux_program" -L "$socket_name" \
      -f /dev/null "$@"
  fi
}

run_tmux() {
  stage=$1
  shift
  watchdog_run "$@" >"$work/$stage.stdout" 2>"$work/$stage.stderr"
}

wait_for_server_exit() {
  tries=0
  while server_process_alive; do
    tries=$((tries + 1))
    [ "$tries" -le 8 ] || return 1
    sleep 1
  done
}

if [ "$native_reference" != 1 ]; then
  mount -t devtmpfs devtmpfs /dev >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devtmpfs (status $status)"
  mount -t proc proc /proc >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount proc (status $status)"
  mkdir -p /dev/pts
  status=$?
  [ "$status" -eq 0 ] || fail "create /dev/pts (status $status)"
  mount -t devpts devpts /dev/pts >/dev/null 2>&1
  status=$?
  [ "$status" -eq 0 ] || fail "mount devpts (status $status)"
  export TERMINFO=/share/terminfo
  [ -r /share/terminfo/x/xterm-256color ] || fail 'ncurses xterm-256color terminfo is missing'
  [ -r /share/terminfo/t/tmux-256color ] || fail 'ncurses tmux-256color terminfo is missing'
  echo 'tmux fork runtime: target wasm candidate'
else
  [ -d /dev/pts ] || fail 'host devpts is unavailable'
  [ -r /proc/self/stat ] || fail 'host proc is unavailable'
  echo 'tmux fork runtime: native reference'
fi

[ -x "$tmux_program" ] || fail "tmux is not executable: $tmux_program"
[ -x "$watchdog" ] || fail "watchdog is not executable: $watchdog"
case "$watchdog_kind" in
busybox)
  "$watchdog" timeout -k 1 2 /bin/busybox true >/dev/null 2>&1
  status=$?
  ;;
gnu)
  "$watchdog" -k 1 2 /bin/true >/dev/null 2>&1
  status=$?
  ;;
*)
  fail "invalid watchdog kind: $watchdog_kind"
  ;;
esac
[ "$status" -eq 0 ] || fail "outer watchdog is unavailable (status $status)"

if [ -z "${TERM:-}" ]; then
  TERM=xterm-256color
fi
export TERM
unset TMUX

work=$(mktemp -d /tmp/tmux-fork.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

export TMUX_TMPDIR="$work/socket"
mkdir -p "$TMUX_TMPDIR"
status=$?
[ "$status" -eq 0 ] || fail 'creating private socket directory'
uid=$(id -u)
status=$?
[ "$status" -eq 0 ] || fail 'reading uid for tmux socket path'
socket_name="tmux-fork-$$"
session_name="tmux-fork-session-$$"
socket_path="$TMUX_TMPDIR/tmux-$uid/$socket_name"

run_tmux stage1-start new-session -d -s "$session_name" -x 80 -y 24 /bin/sh
status=$?
[ "$status" -eq 0 ] || fail "new-session returned $status"
[ -S "$socket_path" ] || fail 'tmux did not create the unique Unix socket'

run_tmux stage1-server-pid display-message -p '#{pid}'
status=$?
[ "$status" -eq 0 ] || fail "display server PID returned $status"
server_pid=$(cat "$work/stage1-server-pid.stdout")
case "$server_pid" in
'' | *[!0-9]*) fail "invalid server PID: $server_pid" ;;
esac
echo 'tmux fork runtime: stage 1 server started on the unique Unix socket'

cat >"$work/pane-command.sh" <<EOF
printf '%s\\n' 'tmux pane command wrote this file' > '$work/pane-result'
printf '%s\\n' "\$\$" > '$work/pane-pid'
tty > '$work/pane-tty'
echo
printf '%s\\n' 'TMUX-FORK-PANE-COMMAND-OK'
printf '%s\\n' 'ready' > '$work/pane-ready'
IFS= read -r pane_release
EOF
printf '%s\n' 'tmux pane command wrote this file' >"$work/pane-expected"

run_tmux stage2-send-command send-keys -l -t "$session_name:0.0" ". '$work/pane-command.sh'"
status=$?
[ "$status" -eq 0 ] || fail "send-keys literal command returned $status"
run_tmux stage2-send-enter send-keys -t "$session_name:0.0" Enter
status=$?
[ "$status" -eq 0 ] || fail "send-keys Enter returned $status"

tries=0
while [ ! -s "$work/pane-ready" ]; do
  tries=$((tries + 1))
  [ "$tries" -le 8 ] || fail 'pane command did not complete its file and PTY writes'
  sleep 1
done
cmp "$work/pane-expected" "$work/pane-result" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'pane command result file content changed'

tries=0
while :; do
  run_tmux stage2-capture capture-pane -p -t "$session_name:0.0"
  status=$?
  [ "$status" -eq 0 ] || fail "capture-pane returned $status"
  if grep -Fx 'TMUX-FORK-PANE-COMMAND-OK' "$work/stage2-capture.stdout" >/dev/null 2>&1; then
    break
  fi
  tries=$((tries + 1))
  [ "$tries" -le 8 ] || fail 'capture-pane did not contain the pane command marker'
  sleep 1
done

run_tmux stage2-pane-pid display-message -p -t "$session_name:0.0" '#{pane_pid}'
status=$?
[ "$status" -eq 0 ] || fail "display pane PID returned $status"
pane_pid=$(cat "$work/stage2-pane-pid.stdout")
case "$pane_pid" in
'' | *[!0-9]*) fail "invalid pane PID: $pane_pid" ;;
esac
recorded_pane_pid=$(cat "$work/pane-pid")
[ "$recorded_pane_pid" = "$pane_pid" ] ||
  fail "pane shell PID $recorded_pane_pid differs from tmux pane PID $pane_pid"
[ -r "/proc/$pane_pid/stat" ] || fail "pane process $pane_pid is absent from procfs"

run_tmux stage2-pane-tty display-message -p -t "$session_name:0.0" '#{pane_tty}'
status=$?
[ "$status" -eq 0 ] || fail "display pane TTY returned $status"
pane_tty=$(cat "$work/stage2-pane-tty.stdout")
recorded_pane_tty=$(cat "$work/pane-tty")
case "$pane_tty" in
/dev/pts/*) ;;
*) fail "pane TTY is not on devpts: $pane_tty" ;;
esac
[ -c "$pane_tty" ] || fail "pane TTY is not a character device: $pane_tty"
[ "$recorded_pane_tty" = "$pane_tty" ] ||
  fail "pane shell TTY $recorded_pane_tty differs from tmux pane TTY $pane_tty"
printf 'tmux fork runtime: stage 2 pane command wrote the file; pane PID %s, TTY %s\n' \
  "$pane_pid" "$pane_tty"

old_server_pid=$server_pid
run_tmux stage3-kill-server kill-server
status=$?
[ "$status" -eq 0 ] || fail "kill-server returned $status"
wait_for_server_exit || fail 'server process remained after kill-server'

run_tmux stage3-stale-socket-check -N has-session -t "$session_name"
status=$?
[ "$status" -ne 0 ] || fail 'old socket still reached a live server after kill-server'

run_tmux stage3-restart new-session -d -s "$session_name" -x 80 -y 24 /bin/sh
status=$?
[ "$status" -eq 0 ] || fail "new-session after kill-server returned $status"
[ -S "$socket_path" ] || fail 'restarted server did not create its socket'
run_tmux stage3-server-pid display-message -p '#{pid}'
status=$?
[ "$status" -eq 0 ] || fail "display restarted server PID returned $status"
server_pid=$(cat "$work/stage3-server-pid.stdout")
case "$server_pid" in
'' | *[!0-9]*) fail "invalid restarted server PID: $server_pid" ;;
esac
[ "$server_pid" != "$old_server_pid" ] ||
  fail "server PID did not change after kill-server ($server_pid)"
run_tmux stage3-has-session has-session -t "$session_name"
status=$?
[ "$status" -eq 0 ] || fail "client command after server restart returned $status"
echo 'tmux fork runtime: stage 3 kill-server and fresh server recovery pass'

run_tmux stage3-final-kill kill-server
status=$?
[ "$status" -eq 0 ] || fail "final kill-server returned $status"
wait_for_server_exit || fail 'final server process remained after kill-server'
server_pid=
socket_name=
cleanup
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  echo 'tmux fork native reference passed'
  exit 0
fi
while :; do sleep 1; done
