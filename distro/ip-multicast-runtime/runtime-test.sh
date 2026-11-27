#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/ip-multicast-runtime

echo "::vm-test::pass"
