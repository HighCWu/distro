#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/sched-affinity-priority-runtime

echo "::vm-test::pass"
