#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/dummy-policy-route-runtime

echo "::vm-test::pass"
