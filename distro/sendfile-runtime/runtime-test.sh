#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/sendfile-runtime

echo "::vm-test::pass"
