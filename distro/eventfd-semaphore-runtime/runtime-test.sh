#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/eventfd-semaphore-runtime

echo "::vm-test::pass"
