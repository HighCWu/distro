#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

for bin in membarrier_test_single_thread membarrier_test_multi_thread; do
  out=$("$bin" 2>&1)
  rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -ne 0 ]; then
    echo "$bin failed with rc=$rc"
    exit 1
  fi

  if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
    echo "$bin reported failure or SKIP"
    exit 1
  fi
done

echo "::vm-test::pass"
