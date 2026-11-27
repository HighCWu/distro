#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

# Test CLOCK_REALTIME (0), CLOCK_MONOTONIC (1), CLOCK_MONOTONIC_RAW (4),
# and CLOCK_BOOTTIME (7) explicitly so CLOCK_HWSPECIFIC (10) is not probed
# (avoiding any SKIP).
for clockid in 0 1 4 7; do
  out=$(inconsistency-check -c "$clockid" -t 1 2>&1)
  rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -ne 0 ]; then
    echo "inconsistency-check -c $clockid -t 1 failed with rc=$rc"
    exit 1
  fi

  if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
    echo "inconsistency-check -c $clockid -t 1 reported failure or SKIP"
    exit 1
  fi
done

echo "::vm-test::pass"
