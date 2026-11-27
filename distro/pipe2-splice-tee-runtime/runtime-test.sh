#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp

/bin/pipe2-splice-tee-runtime

echo "::vm-test::pass"
