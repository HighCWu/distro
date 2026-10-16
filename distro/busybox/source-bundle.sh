#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo 'usage: source-bundle.sh SOURCE_TREE BUILD_MATERIALS ARCHIVE' >&2
  exit 64
fi
source_tree=$(realpath -e "$1")
materials=$(realpath -e "$2")
test -d "$source_tree"
test -d "$materials"
test -s "$source_tree/LICENSE"
test -s "$source_tree/Makefile"
test -s "$materials/busybox.config"
(cd "$materials" && sha256sum --check SHA256SUMS >&2)
source_name=$(basename "$source_tree")
materials_name=$(basename "$materials")
# Transform names only, leaving source symlink targets untouched. Keep the
# roots disjoint even for explicit source overrides with unusual names.
test "$source_name" != "$materials_name"
test "$source_name" != build-materials
test "$materials_name" != busybox
escape_pattern() { printf '%s' "$1" | sed 's/[][\\.^$*,]/\\&/g'; }
source_pattern=$(escape_pattern "$source_name")
materials_pattern=$(escape_pattern "$materials_name")
tar --create --format=gnu --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
  --transform="flags=rh;s,^$source_pattern\\(/\\|$\\),busybox\\1," \
  --transform="flags=rh;s,^$materials_pattern\\(/\\|$\\),build-materials\\1," \
  -C "$(dirname "$source_tree")" "$source_name" \
  -C "$(dirname "$materials")" "$materials_name" |
  gzip -n >"$3"
test -s "$3"
