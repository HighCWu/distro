#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
if [ "$#" -ne 5 ]; then
  echo 'usage: build-materials.sh BUILD_TREE OUTPUT RECIPE METADATA README' >&2
  exit 64
fi
build_tree=$1
output=$2
mkdir -p "$output"
cp "$build_tree/.config" "$output/busybox.config"
cp "$build_tree/LICENSE" "$output/LICENSE"
cp "$3" "$output/package.nix"
cp "$4" "$output/build.json"
cp "$5" "$output/README.md"
cp "$0" "$output/build-materials.sh"
for required in busybox.config LICENSE package.nix build.json README.md build-materials.sh; do
  test -s "$output/$required"
done
cd "$output"
sha256sum busybox.config LICENSE package.nix build.json README.md build-materials.sh >SHA256SUMS
sha256sum --check SHA256SUMS
