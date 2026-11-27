#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/seccomp-strict-runtime

echo "::vm-test::pass"
