#!/bin/sh
# SPDX-License-Identifier: MIT

set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
timeout_program=$(command -v timeout || true)
if [ -z "$timeout_program" ]; then
  printf '%s\n' 'coreutils timeout fork native reference: skipped (no GNU timeout installed)'
  exit 0
fi
if ! "$timeout_program" --version | sed -n '1p' | grep -q 'GNU coreutils'; then
  printf '%s\n' 'coreutils timeout fork native reference: skipped (timeout is not GNU coreutils)'
  exit 0
fi
if ! command -v cc >/dev/null 2>&1; then
  printf '%s\n' 'coreutils timeout fork native reference: skipped (no host C compiler installed)'
  exit 0
fi

work=$(mktemp -d /tmp/coreutils-timeout-fork-native.XXXXXX)
trap 'rm -rf "$work"' 0
helper="$work/coreutils-timeout-signal-helper"
cc -std=c99 -O2 -Wall -Wextra -Werror \
  "$script_dir/timeout-signal-helper.c" -o "$helper"

watchdog_program=$(command -v busybox || true)
if [ -n "$watchdog_program" ]; then
  watchdog_kind=busybox
else
  watchdog_program=$timeout_program
  watchdog_kind=gnu
fi

printf 'coreutils timeout fork native reference: %s\n' "$("$timeout_program" --version | sed -n '1p')"
TIMEOUT_FORK_PROGRAM="$timeout_program" \
  TIMEOUT_FORK_HELPER="$helper" \
  TIMEOUT_FORK_WATCHDOG="$watchdog_program" \
  TIMEOUT_FORK_WATCHDOG_KIND="$watchdog_kind" \
  NATIVE_REFERENCE=1 \
  /bin/sh "$script_dir/runtime-test.sh"
