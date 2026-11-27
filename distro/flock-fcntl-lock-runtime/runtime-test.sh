#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/flock-fcntl-lock-runtime

echo "::vm-test::pass"
