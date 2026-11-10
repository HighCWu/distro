#!/bin/sh
# SPDX-License-Identifier: MIT

set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
rsync_program=$(command -v rsync || true)
if [ -z "$rsync_program" ]; then
  printf '%s\n' 'rsync fork native reference: skipped (no native rsync installed)'
  exit 0
fi
if ! command -v cc >/dev/null 2>&1; then
  printf '%s\n' 'rsync fork native reference: skipped (no host C compiler installed)'
  exit 0
fi
setfacl_program=$(command -v setfacl || true)
getfacl_program=$(command -v getfacl || true)
if [ -z "$setfacl_program" ] || [ -z "$getfacl_program" ]; then
  printf '%s\n' 'rsync fork native reference: skipped (host ACL tools are unavailable)'
  exit 0
fi
rsync_version=$("$rsync_program" --version)
case "$rsync_version" in
*ACLs*xattrs* | *xattrs*ACLs*) ;;
*)
  printf '%s\n' 'rsync fork native reference: skipped (host rsync lacks ACL or xattr support)'
  exit 0
  ;;
esac

work=$(mktemp -d /tmp/rsync-fork-native.XXXXXX)
trap 'rm -rf "$work"' 0
helper="$work/rsync-fork-helper"
xattr_fixture="$work/rsync-fork-xattr-fixture"
cc -std=c99 -O2 -Wall -Wextra -Werror \
  "$script_dir/rsync-fork-helper.c" -o "$helper"
cc -std=c99 -O2 -Wall -Wextra -Werror \
  "$script_dir/xattr-fixture.c" -o "$xattr_fixture"

printf 'rsync fork native reference: %s\n' "$(printf '%s\n' "$rsync_version" | sed -n '1p')"
RSYNC_FORK_PROGRAM="$rsync_program" \
  RSYNC_FORK_HELPER="$helper" \
  RSYNC_FORK_XATTR_FIXTURE="$xattr_fixture" \
  ACL_TOOL_DIR="$(dirname "$setfacl_program")" \
  NATIVE_REFERENCE=1 \
  /bin/sh "$script_dir/runtime-test.sh"
