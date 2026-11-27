#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/bpf-syscall-runtime

echo "::vm-test::pass"
