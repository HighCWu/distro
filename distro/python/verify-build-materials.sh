#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo 'usage: verify-build-materials.sh MATERIALS INSTALLED_ROOT OUTPUT' >&2
  exit 64
fi
materials=$(realpath -e "$1")
installed=$(realpath -e "$2")
output=$(realpath -m "$3")
test -s "$materials/SHA256SUMS"
test -s "$installed/usr/bin/python3.13"
(cd "$materials" && sha256sum --check SHA256SUMS)
mkdir -p "$output"
cp "$materials/SHA256SUMS" "$output/MATERIALS_SHA256SUMS"
# The installed root is a completed Nix output, after its fixup/strip hooks.
# Paths in this manifest are relative to that root, not the configure tree.
(cd "$installed" && sha256sum usr/bin/python3.13) >"$output/BINARY_SHA256SUMS"
(cd "$installed" && sha256sum --check "$output/BINARY_SHA256SUMS")
cd "$output"
sha256sum BINARY_SHA256SUMS MATERIALS_SHA256SUMS >SHA256SUMS
sha256sum --check SHA256SUMS
