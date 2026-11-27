#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/ipv6-policy-route-runtime

echo "::vm-test::pass"
