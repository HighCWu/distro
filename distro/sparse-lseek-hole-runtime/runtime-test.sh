#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/sparse-lseek-hole-runtime

echo "::vm-test::pass"
