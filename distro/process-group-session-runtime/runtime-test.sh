#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/process-group-session-runtime

echo "::vm-test::pass"
