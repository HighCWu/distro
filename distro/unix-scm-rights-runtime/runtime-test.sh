#!/bin/sh
set -eu

export PATH=/bin:/sbin:/usr/bin:/usr/sbin

/bin/unix-scm-rights-runtime

echo "::vm-test::pass"
