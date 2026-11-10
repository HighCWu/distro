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

work=$(mktemp -d /tmp/rsync-fork-native.XXXXXX)
trap 'rm -rf "$work"' 0
helper="$work/rsync-fork-helper"
cc -std=c99 -O2 -Wall -Wextra -Werror \
  "$script_dir/rsync-fork-helper.c" -o "$helper"

printf 'rsync fork native reference: %s\n' "$("$rsync_program" --version | sed -n '1p')"
RSYNC_FORK_PROGRAM="$rsync_program" \
  RSYNC_FORK_HELPER="$helper" \
  NATIVE_REFERENCE=1 \
  /bin/sh "$script_dir/runtime-test.sh"
