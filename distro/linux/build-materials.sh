#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo 'usage: build-materials.sh BUILD_TREE OUTPUT RECIPE METADATA README' >&2
  exit 64
fi
build_tree=$1
output=$2
recipe=$3
metadata=$4
readme=$5
materials="$output/linux-build"
mkdir -p "$materials"
cp "$build_tree/.config" "$materials/kernel.config"
cp "$build_tree/COPYING" "$materials/COPYING"
cp -r "$build_tree/LICENSES" "$materials/LICENSES"
cp "$recipe" "$materials/package.nix"
cp "$metadata" "$materials/build.json"
cp "$readme" "$materials/README.md"
cp "$readme" "$materials/build-materials.README.md"
cp "$0" "$materials/build-materials.sh"
# Fail closed if the kernel bytes or required notices/configuration vanished.
cmp "$build_tree/vmlinux.wasm" "$output/vmlinux.wasm"
for required in vmlinux.wasm linux-build/kernel.config linux-build/COPYING \
  linux-build/LICENSES/preferred/GPL-2.0 linux-build/LICENSES/exceptions/Linux-syscall-note \
  linux-build/package.nix linux-build/build.json linux-build/README.md; do
  test -s "$output/$required"
done
cd "$output"
sums=$(mktemp "${TMPDIR:-/tmp}/linux-wasm-build-sums.XXXXXX")
trap 'rm -f -- "$sums"' EXIT
{ printf '%s\0' vmlinux.wasm; find linux-build -type f ! -path linux-build/SHA256SUMS -print0; } \
  | sort -z | xargs -0 sha256sum > "$sums"
cp "$sums" linux-build/SHA256SUMS
sha256sum --check linux-build/SHA256SUMS
