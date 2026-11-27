#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/ip-multipath-runtime

echo "::vm-test::pass"
