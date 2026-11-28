#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/waitid-stopped-continued-runtime

echo "::vm-test::pass"
