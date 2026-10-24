#!/bin/sh
# SPDX-License-Identifier: MIT
# Runs the real upstream utilities in the disposable Linux/Wasm instance.
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C
set -f

queue=
semaphores=
cleanup() {
  if [ -n "$queue" ]; then ipcrm -q "$queue" >/dev/null 2>&1 || :; fi
  if [ -n "$semaphores" ]; then ipcrm -s "$semaphores" >/dev/null 2>&1 || :; fi
  queue=
  semaphores=
}
trap cleanup EXIT
fail() {
  printf '::vm-test::fail: util-linux IPC: %s\n' "$*"
  exit 1
}
contains() {
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}
identifier() {
  case "$1" in '' | *[!0-9]*) fail "invalid created object ID: $1" ;; esac
}

mount -t devtmpfs devtmpfs /dev || fail "mount devtmpfs"
mount -t proc proc /proc || fail "mount proc"
[ -r /proc/sysvipc/msg ] && [ -r /proc/sysvipc/sem ] || fail "kernel IPC proc interfaces"
for program in ipcmk ipcrm ipcs lsipc; do
  version=$("$program" --version) || fail "$program version"
  contains "$version" 'util-linux' || fail "$program must be the upstream util-linux program"
done

created=$(ipcmk -Q -p 600) || fail "create message queue"
queue=${created##* }
identifier "$queue"
created=$(ipcmk -S 2 -p 600) || fail "create semaphore set"
semaphores=${created##* }
identifier "$semaphores"
report=$(ipcs -q -i "$queue") || fail "query message queue"
contains "$report" "msqid=$queue" || fail "message queue identity"
report=$(ipcs -s -i "$semaphores") || fail "query semaphore set"
if ! contains "$report" "semid=$semaphores" || ! contains "$report" 'nsems = 2'; then
  fail "semaphore identity/count"
fi
echo 'util-linux IPC: upstream creation, object identities and semaphore metadata pass'

report=$(lsipc -q -i "$queue" --raw --noheadings -o ID) || fail "lsipc message queue"
[ "$report" = "$queue" ] || fail "lsipc exact queue ID"
report=$(lsipc -s -i "$semaphores" --raw --noheadings -o ID,NSEMS) || fail "lsipc semaphore set"
# Raw numeric columns are deliberately split; globbing is disabled above.
# shellcheck disable=SC2086
set -- $report
[ "$#" -eq 2 ] && [ "$1" = "$semaphores" ] && [ "$2" = 2 ] || fail "lsipc exact semaphore ID/count"
echo 'util-linux IPC: smartcols-backed lsipc reports live objects pass'

# No System V SHM object or kernel-linear address may be fabricated.
if diagnostic=$(ipcmk -M 4096 2>&1); then fail 'unsupported shared memory unexpectedly succeeded'; fi
contains "$diagnostic" 'Function not implemented' || fail "shared memory must report ENOSYS: $diagnostic"
report=$(ipcs -q -i "$queue") || fail "queue still usable after failed SHM creation"
contains "$report" "msqid=$queue" || fail "SHM failure altered queue"
echo 'util-linux IPC: unsupported shared memory leaves supported objects intact pass'

old_queue=$queue
old_semaphores=$semaphores
ipcrm -q "$queue" || fail "remove message queue"
queue=
ipcrm -s "$semaphores" || fail "remove semaphore set"
semaphores=
# Listing tables avoids relying on ipcs/lsipc's historical missing-ID exit status.
report=$(lsipc -q --raw --noheadings -o ID) || fail "list remaining queues"
for id in $report; do [ "$id" != "$old_queue" ] || fail "removed queue still listed"; done
report=$(lsipc -s --raw --noheadings -o ID) || fail "list remaining semaphores"
for id in $report; do [ "$id" != "$old_semaphores" ] || fail "removed semaphore set still listed"; done
echo 'util-linux IPC: explicit-ID removal, absent objects and cleanup pass'
echo '::vm-test::pass'
while :; do sleep 1; done
