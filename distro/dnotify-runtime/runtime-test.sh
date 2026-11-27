#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp

/bin/dnotify-runtime

echo "::vm-test::pass"
