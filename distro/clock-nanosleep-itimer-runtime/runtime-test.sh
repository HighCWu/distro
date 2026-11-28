#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/clock-nanosleep-itimer-runtime

echo "::vm-test::pass"
