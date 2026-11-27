#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/kcmp-runtime

echo "::vm-test::pass"
