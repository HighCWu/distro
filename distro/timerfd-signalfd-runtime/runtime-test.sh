#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/timerfd-signalfd-runtime

echo "::vm-test::pass"
