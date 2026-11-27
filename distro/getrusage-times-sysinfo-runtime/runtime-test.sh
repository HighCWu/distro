#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/getrusage-times-sysinfo-runtime

echo "::vm-test::pass"
