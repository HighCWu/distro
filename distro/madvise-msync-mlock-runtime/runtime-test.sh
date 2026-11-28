#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/madvise-msync-mlock-runtime

echo "::vm-test::pass"
