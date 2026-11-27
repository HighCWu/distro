#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

mkdir -p /tmp

/bin/epoll-edge-oneshot-runtime

echo "::vm-test::pass"
