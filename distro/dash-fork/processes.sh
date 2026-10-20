#!/bin/dash
# SPDX-License-Identifier: MIT
# Non-interactive upstream-shell workload. No callback clone or custom app API.
fail() {
  printf '::vm-test::fail: dash: %s\n' "$*"
  exit 1
}
bb=${DASH_TEST_BUSYBOX:-/bin/busybox}
shell=${DASH_TEST_SHELL:-/bin/dash}
work=${DASH_TEST_WORK:-/tmp/dash-fork}
# Non-interactive background jobs open /dev/null for their default stdin.
# A raw initramfs has an empty /dev; never mount over the host's device tree.
if [ "${DASH_TEST_HOST:-0}" != 1 ]; then
  "$bb" mount -t devtmpfs devtmpfs /dev || fail 'mount runtime devices'
fi
[ -c /dev/null ] || fail 'missing null character device'
"$bb" mkdir -p "$work" || fail 'create workspace'

scope=parent
(
  # Intentionally change only the child's copy; the parent is checked below.
  # shellcheck disable=SC2030
  scope=child
  [ "$scope" = child ]
) || fail 'subshell execution'
# The lost child assignment is precisely the isolation property under test.
# shellcheck disable=SC2031
[ "$scope" = parent ] || fail 'subshell isolation'
captured=$("$bb" printf 'external-command\n\n') || fail 'external command substitution'
[ "$captured" = external-command ] || fail 'command substitution bytes'
printf 'dash: subshell, external exec and command substitution pass\n'

"$bb" printf 'alpha\nbeta\n' | "$bb" tr 'a-z' 'A-Z' | "$bb" cat >"$work/pipeline" ||
  fail 'three-process pipeline'
[ "$("$bb" cat "$work/pipeline")" = 'ALPHA
BETA' ] || fail 'pipeline output'
printf 'first\nsecond\n' >"$work/input" || fail 'prepare redirection'
exec 9<"$work/input" || fail 'open inherited fd'
captured=$("$bb" cat <&9) || fail 'inherit and redirect fd'
exec 9<&-
[ "$captured" = 'first
second' ] || fail 'inherited fd bytes'
printf 'dash: pipelines and inherited fd redirection pass\n'

"$shell" -c 'exit 23' &
child=$!
wait "$child"
status=$?
[ "$status" -eq 23 ] || fail "background wait status $status"
"$shell" -c 'exit 42'
status=$?
[ "$status" -eq 42 ] || fail "foreground exec status $status"
printf 'dash: background wait and foreground exit status pass\n'

"$work/nonexistent-command" 2>"$work/missing.err"
status=$?
[ "$status" -eq 127 ] || fail "missing command status $status"
printf 'not executable\n' >"$work/denied" || fail 'prepare denied executable'
"$bb" chmod 0600 "$work/denied" || fail 'set denied mode'
"$work/denied" 2>"$work/denied.err"
status=$?
[ "$status" -eq 126 ] || fail "denied command status $status"
"$shell" -c 'if' 2>"$work/syntax.err"
status=$?
[ "$status" -eq 2 ] || fail "syntax error status $status"
captured=$("$bb" printf 'recovered') || fail 'exec after shell errors'
[ "$captured" = recovered ] || fail 'recovery output'
printf 'dash: command errors, syntax unwind and later exec recovery pass\n'

printf '::vm-test::pass\n'
# Host checks exit; Linux init remains alive until the runner closes the machine.
if [ "${DASH_TEST_HOST:-0}" = 1 ]; then exit 0; fi
while :; do :; done
