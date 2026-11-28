#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/eventfd-signalfd-epoll-runtime

echo "::vm-test::pass"
