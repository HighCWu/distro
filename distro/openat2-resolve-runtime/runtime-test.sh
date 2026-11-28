#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/openat2-resolve-runtime

echo "::vm-test::pass"
