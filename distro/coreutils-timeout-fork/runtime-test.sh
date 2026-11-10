#!/bin/busybox sh
# shellcheck shell=sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

timeout_binary=${TIMEOUT_FORK_PROGRAM:-/bin/timeout-fork}
signal_helper=${TIMEOUT_FORK_HELPER:-/bin/coreutils-timeout-signal-helper}
watchdog=${TIMEOUT_FORK_WATCHDOG:-/bin/busybox}
watchdog_kind=${TIMEOUT_FORK_WATCHDOG_KIND:-busybox}
native_reference=${NATIVE_REFERENCE:-0}
work=

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}

fail() {
  printf 'coreutils timeout fork failure: %s\n' "$*" >&2
  cleanup
  work=
  if [ "$native_reference" = 1 ]; then
    exit 1
  fi
  echo '::vm-test::fail'
  exit 1
}

watch_candidate() {
  if [ "$watchdog_kind" = busybox ]; then
    "$watchdog" timeout -k 2 12 "$timeout_binary" "$@"
  else
    "$watchdog" -k 2 12 "$timeout_binary" "$@"
  fi
}

[ -x "$timeout_binary" ] || fail "timeout candidate is not executable: $timeout_binary"
[ -x "$signal_helper" ] || fail "signal helper is not executable: $signal_helper"
[ -x "$watchdog" ] || fail "outer watchdog is not executable: $watchdog"

if [ "$watchdog_kind" = busybox ]; then
  "$watchdog" timeout -k 1 2 /bin/true >/dev/null 2>&1
else
  "$watchdog" -k 1 2 /bin/true >/dev/null 2>&1
fi
status=$?
[ "$status" -eq 0 ] || fail "outer watchdog is unavailable (status $status)"

version=$(watch_candidate --version 2>&1)
status=$?
[ "$status" -eq 0 ] || fail "timeout --version returned $status"
case "$version" in
*'GNU coreutils'*) ;;
*) fail 'expected GNU coreutils timeout' ;;
esac

work=$(mktemp -d /tmp/coreutils-timeout-fork.XXXXXX 2>/dev/null)
status=$?
[ "$status" -eq 0 ] || fail 'creating temporary directory'
[ -n "$work" ] || fail 'creating temporary directory'
trap cleanup 0

output=$(watch_candidate 5 "$signal_helper" --print 'timeout command completed' 2>"$work/success.stderr")
status=$?
[ "$status" -eq 0 ] || fail "ordinary command returned $status"
[ "$output" = 'timeout command completed' ] || fail "ordinary command output changed: $output"
echo 'coreutils timeout fork: ordinary command output and success status pass'

watch_candidate 5 "$signal_helper" --exit 23 >"$work/exit.stdout" 2>"$work/exit.stderr"
status=$?
[ "$status" -eq 23 ] || fail "ordinary command exit status was $status, expected 23"
echo 'coreutils timeout fork: ordinary command exit status propagates pass'

watch_candidate -k 1 1 "$signal_helper" --ignore-term "$work/kill.marker" \
  >"$work/kill.stdout" 2>"$work/kill.stderr"
status=$?
[ "$status" -eq 137 ] || fail "-k TERM-ignoring command returned $status, expected 137"
grep -Fx 'SIGTERM' "$work/kill.marker" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail '-k did not deliver TERM before KILL'
echo 'coreutils timeout fork: -k delivers TERM then KILL to a CPU-bound command pass'

watch_candidate --preserve-status 1 "$signal_helper" \
  --term-exit "$work/preserve.marker" 42 >"$work/preserve.stdout" 2>"$work/preserve.stderr"
status=$?
[ "$status" -eq 42 ] || fail "--preserve-status returned $status, expected command status 42"
grep -Fx 'SIGTERM' "$work/preserve.marker" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail '--preserve-status did not deliver TERM to the command'
echo 'coreutils timeout fork: --preserve-status returns the command status pass'

missing_command=$work/missing-command
watch_candidate 5 "$missing_command" >"$work/enoent.stdout" 2>"$work/enoent.stderr"
status=$?
[ "$status" -eq 127 ] || fail "exec ENOENT returned $status, expected 127"
grep -F 'failed to run command' "$work/enoent.stderr" >/dev/null 2>&1
status=$?
[ "$status" -eq 0 ] || fail 'exec ENOENT diagnostic was missing'
echo 'coreutils timeout fork: exec ENOENT returns 127 pass'

output=$(watch_candidate 5 "$signal_helper" --print recovered 2>"$work/recovery.stderr")
status=$?
[ "$status" -eq 0 ] || fail "command after ENOENT returned $status"
[ "$output" = recovered ] || fail 'command after ENOENT did not recover'
echo 'coreutils timeout fork: later command recovers after exec ENOENT pass'

rm -rf "$work"
status=$?
[ "$status" -eq 0 ] || fail 'temporary tree cleanup'
work=
trap - 0
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
