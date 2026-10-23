#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# Target-only: the CI runner boots an isolated Wasm machine for this script.

holder=
fail() {
  [ -z "$holder" ] || kill "$holder" 2>/dev/null || :
  printf '::vm-test::fail: busybox namespaces: %s\n' "$*"
  while :; do :; done
}
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t devtmpfs devtmpfs /dev || fail 'mount devtmpfs'
mount -t proc proc /proc || fail 'mount proc'
mkdir -p /tmp || fail 'temporary directory'
mkfifo /tmp/ns-ready /tmp/ns-release || fail 'synchronization pipes'
before=$(hostname) || fail 'original hostname'
label=linux-wasm-nsenter

# A ready message is sent only after unshare and hostname succeed. Neither a
# startup delay nor a successful exec alone proves namespace isolation.
/namespace-holder "$label" &
holder=$!
IFS= read -r ready </tmp/ns-ready || fail 'holder readiness'
[ "$ready" = ready ] || fail 'holder readiness token'
kill -0 "$holder" || fail 'holder still alive'

uts=$(readlink /proc/"$holder"/ns/uts) || fail 'holder UTS identity'
ipc=$(readlink /proc/"$holder"/ns/ipc) || fail 'holder IPC identity'
net=$(readlink /proc/"$holder"/ns/net) || fail 'holder network identity'
[ "$uts" != "$(readlink /proc/self/ns/uts)" ] || fail 'distinct UTS'
[ "$ipc" != "$(readlink /proc/self/ns/ipc)" ] || fail 'distinct IPC'
[ "$net" != "$(readlink /proc/self/ns/net)" ] || fail 'distinct network'

# Expansion deliberately belongs to the shell after setns, not this parent.
# shellcheck disable=SC2016
/bin/busybox nsenter -t "$holder" -u -i -n /bin/busybox sh -c '
  [ "$(hostname)" = "$1" ] &&
  [ "$(readlink /proc/self/ns/uts)" = "$2" ] &&
  [ "$(readlink /proc/self/ns/ipc)" = "$3" ] &&
  [ "$(readlink /proc/self/ns/net)" = "$4" ]
' namespace-check "$label" "$uts" "$ipc" "$net" || fail 'enter three namespaces and exec'
[ "$(hostname)" = "$before" ] || fail 'parent hostname unchanged'
echo 'busybox namespaces: standard unshare holder, nsenter UTS/IPC/network identities and exec pass'

# The PID option selects nsenter's existing child/wait path. The target PID
# namespace here is still the original one; creation of a new PID namespace
# is covered separately by the C fixture, not claimed by this workload.
# shellcheck disable=SC2016
/bin/busybox nsenter -t "$holder" -u -p /bin/busybox sh -c '
  [ "$(hostname)" = "$1" ] || exit 105
  exit 42
' namespace-child "$label"
status=$?
[ "$status" -eq 42 ] || fail "child exit propagation returned $status"
echo 'busybox namespaces: PID-option child path, inherited UTS and exit status pass'

: >/tmp/not-a-namespace || fail 'invalid namespace fixture'
if /bin/busybox nsenter -u/tmp/not-a-namespace /bin/busybox true >/tmp/ns-error 2>&1; then
  fail 'ordinary file accepted as namespace'
fi
grep -q 'setns()' /tmp/ns-error || fail 'invalid namespace reached setns'
/bin/busybox nsenter -t "$holder" -u /bin/busybox hostname >/tmp/ns-result || fail 'recovery after rejection'
grep -qx "$label" /tmp/ns-result || fail 'recovery hostname'
[ "$(hostname)" = "$before" ] || fail 'parent namespace survived children'
printf 'release\n' >/tmp/ns-release || fail 'release holder'
wait "$holder" || fail 'holder exit and reap'
holder=
rm /tmp/ns-ready /tmp/ns-release /tmp/not-a-namespace /tmp/ns-error /tmp/ns-result || fail 'cleanup files'
umount /proc || fail 'cleanup proc'
echo 'busybox namespaces: invalid handle rejection, later exec, holder reap and cleanup pass'
echo '::vm-test::pass'
while :; do :; done
