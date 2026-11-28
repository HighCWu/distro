#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/sigwaitinfo-sigqueue-rt-runtime

echo "::vm-test::pass"
