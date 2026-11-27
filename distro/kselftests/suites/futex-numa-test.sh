#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

out=$(futex_numa -t 4 -c 2 -s 2 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "futex_numa -t 4 -c 2 -s 2 failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "futex_numa -t 4 -c 2 -s 2 reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
