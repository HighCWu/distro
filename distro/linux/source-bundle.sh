#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo 'usage: source-bundle.sh SOURCE_TREE LINUX_OUTPUT ARCHIVE' >&2
  exit 64
fi
source_tree=$(realpath -e "$1")
linux_output=$2
archive=$3
test -d "$source_tree"
test -d "$linux_output/linux-build"
test ! -L "$linux_output/linux-build"
test -s "$source_tree/COPYING"
test -s "$source_tree/Makefile"
test -s "$linux_output/linux-build/kernel.config"
source_name=$(basename "$source_tree")
# Keep the two archive roots disjoint, including with source overrides.
test "$source_name" != linux-build
source_parent=$(dirname "$source_tree")
# Escape a basename for a GNU basic regular expression and the ',' delimiter.
pattern=$(printf '%s' "$source_name" | sed 's/[][\\.^$*,]/\\&/g')
# Rewrite archive member/hardlink names, but preserve source symlink targets.
# No staging copy or uncompressed archive is created. Stable headers and gzip
# metadata make the result reproducible for identical source/material inputs.
tar --create --format=gnu --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
  --transform="flags=rh;s,^$pattern\\(/\\|$\\),linux\\1," \
  --transform='flags=rh;s,^linux-build\(/\|$\),build-materials\1,' \
  -C "$source_parent" "$source_name" -C "$linux_output" linux-build |
  gzip -n >"$archive"
test -s "$archive"
