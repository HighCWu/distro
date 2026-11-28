#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/posix-spawn-cloexec-sigmask-runtime

echo "::vm-test::pass"
