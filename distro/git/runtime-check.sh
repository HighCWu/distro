#!/bin/sh
# SPDX-License-Identifier: MIT
# Use explicit status checks: the installed hush has no nounset (-u) mode.

read -r bits </git-address-bits || exit 1
case "$bits" in
32) bytes=4 ;;
64) bytes=8 ;;
*)
  echo "invalid Git runtime width" >&2
  exit 1
  ;;
esac
options=$(git version --build-options) || exit 1
printf '%s\n' "$options" | grep -qx "sizeof-long: $bytes" || exit 1
printf '%s\n' "$options" | grep -qx "sizeof-size_t: $bytes" || exit 1
printf 'Git ABI: long and size_t match %s bits\n' "$bits"
/bin/sh /git-notice-check.sh || exit 1
echo "Git notices: selected installed originals and default patch checksums verified"
