#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

out=$(proc-2-is-kthread 2>&1)
rc=$?
if [ -n "$out" ]; then
  printf '%s\n' "$out"
fi

if [ "$rc" -ne 0 ]; then
  echo "proc-2-is-kthread failed with rc=$rc"
  exit 1
fi

echo "::vm-test::pass"
