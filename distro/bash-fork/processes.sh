#!/bin/bash
# SPDX-License-Identifier: MIT
# Independent standard-fork candidate, not the default callback-based Bash.
fail() {
  printf '::vm-test::fail: bash-fork: %s\n' "$*"
  exit 1
}
bb=${BASH_FORK_TEST_BUSYBOX:-/bin/busybox}
shell=${BASH_FORK_TEST_SHELL:-/bin/bash}
work=${BASH_FORK_TEST_WORK:-/tmp/bash-standard-fork}
if [ "${BASH_FORK_TEST_HOST:-0}" != 1 ]; then
  "$bb" mount -t devtmpfs devtmpfs /dev || fail 'mount devices'
  "$bb" mkdir -p /proc || fail 'prepare procfs'
  "$bb" mount -t proc proc /proc || fail 'mount procfs'
  [ -e /dev/fd ] || "$bb" ln -s /proc/self/fd /dev/fd || fail 'prepare descriptor paths'
fi
[ -c /dev/null ] || fail 'missing null device'
"$bb" mkdir -p "$work" || fail 'create workspace'
scope=parent
(
  # Deliberately change only the child's private copy.
  # shellcheck disable=SC2030
  scope=child
  [ "$scope" = child ]
) || fail 'subshell'
# The lost child assignment is the isolation property under test.
# shellcheck disable=SC2031
[ "$scope" = parent ] || fail 'subshell isolation'
compute() {
  local value=local
  (printf '%s' "$value")
}
[ "$(compute)" = local ] || fail 'local scope across nested continuation'
captured=$("$bb" printf 'external\n\n') || fail 'external substitution'
[ "$captured" = external ] || fail 'substitution bytes'
"$bb" printf 'alpha\nbeta\n' | "$bb" tr 'a-z' 'A-Z' | "$bb" cat >"$work/pipeline" || fail 'pipeline'
[ "$("$bb" cat "$work/pipeline")" = $'ALPHA\nBETA' ] || fail 'pipeline output'
printf 'bash-fork: standard fork, local scopes, command substitution and pipelines pass\n'

IFS= read -r value < <("$bb" printf 'process-substitution\n') || fail 'process substitution'
[ "$value" = process-substitution ] || fail 'process substitution bytes'
coproc PRODUCER {
  IFS= read -r token
  printf 'reply:%s\n' "$token"
}
producer=$PRODUCER_PID
# Save fd copies before the shell retires the coprocess's own descriptors.
exec 8<&"${PRODUCER[0]}" 9>&"${PRODUCER[1]}" || fail 'retain coprocess descriptors'
printf 'request\n' >&9 || fail 'coprocess request'
IFS= read -r value <&8 || fail 'coprocess reply'
exec 8<&- 9>&-
[ "$value" = reply:request ] || fail 'coprocess bytes'
wait "$producer" || fail 'coprocess wait'
printf 'bash-fork: process substitution and coprocess fd lifetimes pass\n'

"$shell" -c 'exit 23' &
child=$!
wait "$child"
[ "$?" -eq 23 ] || fail 'background exit status'
seen=0
trap 'seen=1' USR1
"$bb" kill -USR1 "$$" || fail 'deliver shell trap'
[ "$seen" -eq 1 ] || fail 'signal trap execution'
trap - USR1
# shellcheck disable=SC2031
[ "$scope" = parent ] || fail 'parent state after children'
printf 'bash-fork: background wait, signal trap and parent isolation pass\n'

"$work/nonexistent-command" 2>"$work/missing.err"
[ "$?" -eq 127 ] || fail 'missing command status'
printf 'not executable\n' >"$work/denied"
"$bb" chmod 0600 "$work/denied" || fail 'prepare denied executable'
"$work/denied" 2>"$work/denied.err"
[ "$?" -eq 126 ] || fail 'denied command status'
"$shell" -c 'if' 2>"$work/syntax.err"
[ "$?" -eq 2 ] || fail 'syntax error status'
[ "$("$bb" printf recovered)" = recovered ] || fail 'execution after shell errors'
printf 'bash-fork: exec errors, syntax recovery and later child execution pass\n'
printf '::vm-test::pass\n'
