#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# shellcheck shell=sh
set -eu
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

consumer=@consumer@
lua=${LUA_EXTENSION_LUA:-/bin/lua}
module=${LUA_EXTENSION_MODULE:-/lib/lua/5.4/nativeprobe.so}
native_reference=${LUA_EXTENSION_NATIVE_REFERENCE:-0}

fail() {
  printf 'lua extension runtime failure: %s\n' "$*" >&2
  exit 1
}

[ -r "$consumer" ] || fail "missing consumer script: $consumer"
[ -r "$module" ] || fail "missing nativeprobe module: $module"

workdir=$(mktemp -d /tmp/lua-extension-runtime.XXXXXX)
trap 'rm -rf "$workdir"' EXIT
missing_module=$workdir/missing/nativeprobe.so
recovery_dir=$workdir/recovery
recovery_module=$recovery_dir/nativeprobe.so
mkdir -p "$recovery_dir"
cp "$module" "$recovery_module" || fail "could not prepare valid recovery module copy"

"$lua" "$consumer" "$module" "$missing_module" "$recovery_module" ||
  fail "Lua extension consumer failed"

rm -rf "$workdir"
trap - EXIT
[ ! -e "$workdir" ] || fail "temporary directory remained after cleanup"
echo 'lua extension: process exit and temporary files cleanup pass'
echo '::vm-test::pass'
if [ "$native_reference" = 1 ]; then
  exit 0
fi
while :; do sleep 1; done
