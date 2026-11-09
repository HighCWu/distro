#!/bin/busybox sh
# SPDX-License-Identifier: MIT
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

python=${PYTHON_EXTENSION_PYTHON:-/usr/bin/python3.13}
module_dir=${PYTHON_EXTENSION_MODULE_DIR:-/plugins}
script=${PYTHON_EXTENSION_SCRIPT:-/python-extension-runtime.py}
native_reference=${PYTHON_EXTENSION_NATIVE_REFERENCE:-0}
bits=${PYTHON_EXTENSION_BITS:-}
if [ -z "$bits" ] && [ "$native_reference" != 1 ]; then
  bits=$(cat /python-address-bits)
fi
workdir=$(mktemp -d /tmp/python-extension-runtime.XXXXXX)
trap 'rm -rf "$workdir"' EXIT
export TMPDIR="$workdir"

set -- "$module_dir"
if [ -n "$bits" ]; then
  set -- "$@" --bits "$bits"
fi
"$python" "$script" "$@"

rm -rf "$workdir"
trap - EXIT
echo 'python extension: files and stdlib import with clean interpreter exit pass'
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
