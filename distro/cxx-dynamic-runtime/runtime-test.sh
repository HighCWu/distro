#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

program=${CXX_DYNAMIC_PROGRAM:-/bin/cxx-dynamic-runtime}
plugin=${CXX_DYNAMIC_PLUGIN:-/plugins/plugin.so}
native_reference=${CXX_DYNAMIC_NATIVE_REFERENCE:-0}

"$program" "$plugin"
echo 'cxx dynamic: repeated calls and recovered exceptions after clean process exit pass'
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
