#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

# Exclude two_chunks_blocking and two_chunks_overlap_blocking because they
# use async { fork(); }. The remaining 9 TAP cases (single_chunk, two_chunks,
# two_chunks_overlap across stream/dgram/seqpacket) are fork-free and skip-free.
out=$(so_peek_off -T two_chunks_blocking -T two_chunks_overlap_blocking 2>&1)
rc=$?
printf '%s\n' "$out"

if [ "$rc" -ne 0 ]; then
  echo "so_peek_off failed with rc=$rc"
  exit 1
fi

if printf '%s\n' "$out" | grep -qE '^not ok|#[[:space:]]*SKIP|FAIL'; then
  echo "so_peek_off reported failure or SKIP"
  exit 1
fi

echo "::vm-test::pass"
