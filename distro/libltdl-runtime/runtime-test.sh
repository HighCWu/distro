#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

runtime=${1:-libltdl-runtime}
plugin_source_dir=${2:-/plugins}
workdir=$(mktemp -d /tmp/libltdl-runtime.XXXXXX)
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/modules"
cp "$plugin_source_dir/sample.so" "$workdir/modules/sample.so"
cp "$plugin_source_dir/provider.so" "$workdir/provider.so"
cat >"$workdir/sample.la" <<EOF
# libtool library file
dlname='sample.so'
library_names='sample.so'
old_library=''
dependency_libs=''
installed=yes
libdir='$workdir/modules'
EOF

"$runtime" "$workdir"
rm -rf "$workdir"
trap - EXIT
echo '::vm-test::pass'
if [ "${LTDL_NATIVE_REFERENCE:-0}" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
