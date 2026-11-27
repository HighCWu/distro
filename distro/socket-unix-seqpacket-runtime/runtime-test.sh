#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/socket-unix-seqpacket-runtime

echo "::vm-test::pass"
