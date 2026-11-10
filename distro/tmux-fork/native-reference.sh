#!/bin/sh
# SPDX-License-Identifier: MIT

set -eu

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tmux_program=${TMUX_FORK_PROGRAM:-}
if [ -z "$tmux_program" ]; then
  tmux_program=$(command -v tmux || true)
  if [ -z "$tmux_program" ]; then
    printf '%s\n' 'tmux fork native reference: skipped (no host tmux installed)'
    exit 0
  fi
elif [ ! -x "$tmux_program" ]; then
  printf 'tmux fork native reference: configured tmux is not executable: %s\n' \
    "$tmux_program" >&2
  exit 1
fi

watchdog=${TMUX_FORK_WATCHDOG:-}
if [ -z "$watchdog" ]; then
  watchdog=$(command -v timeout || true)
fi
if [ -z "$watchdog" ] || [ ! -x "$watchdog" ]; then
  printf '%s\n' 'tmux fork native reference: skipped (no host timeout watchdog installed)'
  exit 0
fi

printf 'tmux fork native reference: %s\n' "$tmux_program"
TMUX_FORK_PROGRAM="$tmux_program" \
  TMUX_FORK_WATCHDOG="$watchdog" \
  TMUX_FORK_WATCHDOG_KIND=gnu \
  NATIVE_REFERENCE=1 \
  /bin/sh "$script_dir/runtime-test.sh"
