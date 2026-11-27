#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

mkdir -p /tmp/unix-connect-test
cd /tmp/unix-connect-test || exit 1

out=$(unix_connect 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "unix_connect failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "unix_connect reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
