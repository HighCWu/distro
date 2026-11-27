#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/signal-sigaltstack-sigaction-runtime

echo "::vm-test::pass"
