// SPDX-License-Identifier: MIT
// The pinned NOMMU hush implements errexit but not nounset. Keep explicit
// value assertions; do not use `set -u` as a substitute for testing them.
export const publicShellScript = String.raw`
set -e
[ "$PWD" = /tmp ]
[ "$1" = 'public shell arg' ]
[ "$AGENT_RUNTIME_VALUE" = 'public shell env' ]
printf '%s\n' "$1" | grep -qx 'public shell arg'
root=$(cat /etc/agent-runtime-root)
[ "$root" = native-wasm64-root ]
printf '%s\n' "$AGENT_RUNTIME_VALUE" > /tmp/public-shell-source
cp /tmp/public-shell-source /tmp/public-shell-copy
[ "$(cat /tmp/public-shell-copy)" = 'public shell env' ]
if /bin/sh -c 'exit 7'; then exit 90; else status=$?; fi
[ "$status" -eq 7 ]
sleep 0.01 &
child=$!
wait "$child"
rm /tmp/public-shell-source /tmp/public-shell-copy
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
