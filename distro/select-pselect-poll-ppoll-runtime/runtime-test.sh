#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/select-pselect-poll-ppoll-runtime

echo "::vm-test::pass"
