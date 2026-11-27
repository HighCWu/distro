#!/bin/busybox sh
set -eu
out=$(/bin/libmagic-static-client)
echo "$out"
[ "$out" = "libmagic: static pkg-config consumer passed" ]
echo "::vm-test::pass"
while :; do :; done
