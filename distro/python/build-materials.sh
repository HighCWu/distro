#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail
if [ "$#" -lt 4 ]; then
  echo 'usage: build-materials.sh BUILD_TREE OUTPUT RECIPE METADATA [PATCH ...]' >&2
  exit 64
fi
build_tree=$1
output=$2
recipe=$3
metadata=$4
shift 4
mkdir -p "$output/Modules" "$output/patches"
for required in pyconfig.h Makefile config.log Modules/Setup.stdlib Modules/Setup.bootstrap LICENSE; do
  test -s "$build_tree/$required"
  cp "$build_tree/$required" "$output/$required"
done
cp "$recipe" "$output/package.nix"
cp "$metadata" "$output/build.json"
cp "$0" "$output/build-materials.sh"
index=0
for patch in "$@"; do
  test -s "$patch"
  printf -v name '%03d.patch' "$index"
  cp "$patch" "$output/patches/$name"
  index=$((index + 1))
done
test -s "$output/package.nix"
test -s "$output/build.json"
cd "$output"
find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
sha256sum --check SHA256SUMS
