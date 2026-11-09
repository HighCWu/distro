#!/bin/busybox sh
# SPDX-License-Identifier: MIT
# shellcheck shell=sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin

program=${FORK_MEMORY_ADVICE_PROGRAM:-/bin/fork-memory-advice}
native_reference=${FORK_MEMORY_ADVICE_NATIVE_REFERENCE:-0}

if "$program"; then
  echo 'fork memory advice: cleanup and later fork recovery pass'
  echo '::vm-test::pass'
  if [ "$native_reference" = 1 ]; then
    exit 0
  fi
else
  status=$?
  printf '::vm-test::fail: fork memory advice program exited with status %s\n' "$status"
  if [ "$native_reference" = 1 ]; then
    exit "$status"
  fi
fi
while :; do sleep 1; done
