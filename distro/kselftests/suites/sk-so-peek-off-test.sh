#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

out=$(sk_so_peek_off 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "sk_so_peek_off failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "sk_so_peek_off reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
