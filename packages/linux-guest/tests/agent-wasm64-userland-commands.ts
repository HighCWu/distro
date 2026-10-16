// SPDX-License-Identifier: MIT
// The pinned NOMMU hush implements errexit but not nounset. Keep explicit
// value assertions; do not use `set -u` as a substitute for testing them.
// This hush also resets $? when skipping a failed condition's THEN branch.
// Capture directly in an OR list, not after entering ELSE.
export const publicChildStatusScript = String.raw`
status=0
/bin/sh -c 'exit 7' || status=$?
[ "$status" -eq 7 ] || fail child-status "$status"
`;

export const publicShellScript = String.raw`
set -e
fail() {
  printf 'public shell check failed: %s [%s]\n' "$1" "$2" >&2
  exit 1
}
[ "$PWD" = /tmp ] || fail cwd "$PWD"
[ "$1" = 'public shell arg' ] || fail argv "$1"
[ "$AGENT_RUNTIME_VALUE" = 'public shell env' ] || fail env "$AGENT_RUNTIME_VALUE"
printf '%s\n' "$1" | grep -qx 'public shell arg' || fail pipeline "$?"
root=$(cat /etc/agent-runtime-root) || fail root-read "$?"
[ "$root" = native-wasm64-root ] || fail root-marker "$root"
printf '%s\n' "$AGENT_RUNTIME_VALUE" > /tmp/public-shell-source || fail source-write "$?"
cp /tmp/public-shell-source /tmp/public-shell-copy || fail copy "$?"
copy=$(cat /tmp/public-shell-copy) || fail copy-read "$?"
[ "$copy" = 'public shell env' ] || fail copy-content "$copy"
${publicChildStatusScript}
sleep 0.01 &
child=$!
wait "$child" || fail child-wait "$?"
rm /tmp/public-shell-source /tmp/public-shell-copy || fail remove "$?"
printf '%s\n' 'native shell passed'
`;

export const publicStreamScript = String.raw`
set -e
[ -n "$TMPDIR" ]
tee "$TMPDIR/public-stream-copy" | cat
cat "$TMPDIR/public-stream-copy" >&2
rm "$TMPDIR/public-stream-copy"
`;

// Publish readiness by rename only after the complete marker was written.
export const publicAbortScript = String.raw`
set -e
printf ready > /tmp/public-run-ready.tmp
mv /tmp/public-run-ready.tmp /tmp/public-run-ready
exec sleep 30
`;
