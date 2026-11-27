#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

# Run only the `uid` variant (.unshare = 0) because CONFIG_USER_NS is not
# enabled in arch/wasm/configs/defconfig (avoids CLONE_NEWUSER failure in
# `uid_unshare`).
out=$(diag_uid -v uid 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "diag_uid -v uid failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "diag_uid -v uid reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
