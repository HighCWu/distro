#!/bin/sh
set -u

mount -t proc proc /proc
/vm-test-setup-dev-fd

out=$(so_netns_cookie 2>&1)
rc=$?
if [ -n "$out" ]; then
  printf '%s\n' "$out"
fi

if [ "$rc" -ne 0 ]; then
  echo "so_netns_cookie failed with rc=$rc"
  exit 1
fi

echo "::vm-test::pass"
