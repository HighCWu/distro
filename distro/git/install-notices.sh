#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

if [ "$#" -ne 6 ]; then
  echo "usage: install-notices.sh <git-source> <curl-output> <output> <readme> <patch> <integration-license>" >&2
  exit 2
fi
git_source=$1
curl_output=$2
destination=$3/usr/share/licenses/git

# These selected inputs must be real, nonempty files. Do not silently drop
# a notice when an upstream source layout or dependency output changes.
copy_notice() {
  if [ ! -f "$1" ] || [ ! -s "$1" ]; then
    echo "missing or empty selected notice: $2" >&2
    return 1
  fi
  install -Dm644 "$1" "$destination/$2"
}

copy_notice "$git_source/COPYING" git-COPYING
copy_notice "$git_source/sha1dc/LICENSE.txt" sha1dc-LICENSE.txt
copy_notice "$git_source/reftable/LICENSE" reftable-LICENSE
for name in regcomp.c regex.c regex.h regex_internal.c regex_internal.h regexec.c; do
  copy_notice "$git_source/compat/regex/$name" "compat-regex/$name"
done
for name in curl-COPYING zlib.h openssl-LICENSE.txt musl-COPYRIGHT compiler-rt-LICENSE.TXT integration-MIT; do
  copy_notice "$curl_output/share/licenses/curl/$name" "linked/$name"
done
copy_notice "$4" README.md
copy_notice "$5" run-command-posix-spawn.patch
copy_notice "$6" notice-tools-MIT

(
  cd "$destination"
  # The output manifest is explicitly excluded from the input file list.
  # shellcheck disable=SC2094
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS
)
