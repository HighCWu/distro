#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

out=$(mqueue-lat 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "mqueue-lat failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "mqueue-lat reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
