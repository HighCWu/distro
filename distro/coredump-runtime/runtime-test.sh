#!/bin/busybox sh
# SPDX-License-Identifier: MIT

export PATH=/bin:/sbin:/usr/bin:/usr/sbin
export LC_ALL=C

fail() {
  printf '%s\n' "::vm-test::fail: coredump: $*"
  while :; do sleep 1; done
}

mount -t proc proc /proc || fail 'mount proc'
mkdir -p /tmp/core-file /tmp/core-pipe

echo '/tmp/core-file/core.%p' > /proc/sys/kernel/core_pattern || fail 'set file core_pattern'
(
  ulimit -c unlimited
  coredump-runtime --crash >/dev/null 2>&1
)
status=$?
[ "$status" -ge 128 ] || fail "expected signal termination for file dump (status=$status)"

file_core=
for f in /tmp/core-file/core.*; do
  if [ -f "$f" ]; then
    file_core=$f
    break
  fi
done
[ -n "$file_core" ] || fail 'missing file core dump'
file_out=$(coredump-runtime --verify "$file_core" 2>&1) || fail "file core verify failed: $file_out"
printf '%s\n' "$file_out"

echo '|/bin/coredump-runtime --pipe-sink /tmp/core-pipe/core.elf' > /proc/sys/kernel/core_pattern || fail 'set pipe core_pattern'
echo 1 > /proc/sys/kernel/core_pipe_limit || fail 'set core_pipe_limit'
(
  ulimit -c unlimited
  coredump-runtime --crash >/dev/null 2>&1
)
status=$?
[ "$status" -ge 128 ] || fail "expected signal termination for pipe dump (status=$status)"
[ -s /tmp/core-pipe/core.elf ] || fail 'missing pipe core dump'
pipe_out=$(coredump-runtime --verify /tmp/core-pipe/core.elf 2>&1) || fail "pipe core verify failed: $pipe_out"
printf '%s\n' "$pipe_out"

rm -rf /tmp/core-file /tmp/core-pipe
umount /proc || fail 'umount proc'
printf '%s\n' '::vm-test::pass'
while :; do sleep 1; done
