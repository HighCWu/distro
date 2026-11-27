#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/watch-queue-runtime

echo "::vm-test::pass"
