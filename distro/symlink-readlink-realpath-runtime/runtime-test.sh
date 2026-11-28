#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/symlink-readlink-realpath-runtime

echo "::vm-test::pass"
