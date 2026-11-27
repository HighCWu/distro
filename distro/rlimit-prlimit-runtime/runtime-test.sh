#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp

/bin/rlimit-prlimit-runtime

echo "::vm-test::pass"
