#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/pidfd-getfd-runtime

echo "::vm-test::pass"
