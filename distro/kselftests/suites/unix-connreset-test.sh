#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd
mkdir -p /tmp

# Run stream and seqpacket variants (all 3 tests: eof, reset_unread_behavior,
# reset_closed_embryo). The dgram variant is omitted because its
# reset_closed_embryo case calls exit(KSFT_XFAIL) directly.
for variant in stream seqpacket; do
  out=$(unix_connreset -v "$variant" 2>&1)
  rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -ne 0 ]; then
    echo "unix_connreset -v $variant failed with rc=$rc"
    exit 1
  fi

  if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
    echo "unix_connreset -v $variant reported failure or SKIP"
    exit 1
  fi
done

echo "::vm-test::pass"
