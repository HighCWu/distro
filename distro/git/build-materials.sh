#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Collect configuration, never execute generated Git shell fragments.
set -euo pipefail
if [ "$#" -lt 7 ]; then
  echo 'usage: build-materials.sh BUILD_TREE OUTPUT INSTALLED_ROOT RECIPE METADATA COMPILER README [PATCH ...]' >&2
  exit 64
fi
build_tree=$1
output=$2
installed=$3
recipe=$4
metadata=$5
compiler=$6
readme=$7
shift 7
configured=(Makefile config.mak.uname GIT-BUILD-OPTIONS GIT-CFLAGS GIT-PREFIX GIT-VERSION-FILE COPYING linux-wasm-make-arguments.nul)
for required in "${configured[@]}"; do
  test -s "$build_tree/$required"
done
for required in "$recipe" "$metadata" "$readme" "$@" "$installed/usr/bin/git" "$installed/usr/libexec/git-core/git-remote-http"; do
  test -s "$required"
done
mkdir -p "$output/patches"
collected=("${configured[@]}" package.nix build.json README.md build-materials.sh compiler-version.txt toolchain-environment.nul GIT-LDFLAGS.status BINARY_SHA256SUMS)
for required in "${configured[@]}"; do
  cp "$build_tree/$required" "$output/$required"
done
# Upstream's tracking rule may leave no file when ALL_LDFLAGS is empty.
# Record that absence explicitly, rather than fabricating upstream output.
if [ -e "$build_tree/GIT-LDFLAGS" ]; then
  test -s "$build_tree/GIT-LDFLAGS"
  cp "$build_tree/GIT-LDFLAGS" "$output/GIT-LDFLAGS"
  printf '%s\n' present >"$output/GIT-LDFLAGS.status"
  collected+=(GIT-LDFLAGS)
else
  printf '%s\n' absent >"$output/GIT-LDFLAGS.status"
fi
cp "$recipe" "$output/package.nix"
cp "$metadata" "$output/build.json"
cp "$readme" "$output/README.md"
cp "$0" "$output/build-materials.sh"
"$compiler" --version >"$output/compiler-version.txt"
test -s "$output/compiler-version.txt"
# Whitelist build flags only; never dump the builder's entire environment.
printf '%s\0' "NIX_CFLAGS_COMPILE=${NIX_CFLAGS_COMPILE-}" "NIX_CFLAGS_LINK=${NIX_CFLAGS_LINK-}" "NIX_LDFLAGS=${NIX_LDFLAGS-}" >"$output/toolchain-environment.nul"
index=0
for patch in "$@"; do
  printf -v name '%03d.patch' "$index"
  cp "$patch" "$output/patches/$name"
  collected+=("patches/$name")
  index=$((index + 1))
done
(
  cd "$installed"
  sha256sum usr/bin/git usr/libexec/git-core/git-remote-http
) >"$output/BINARY_SHA256SUMS"
cd "$output"
sha256sum "${collected[@]}" >SHA256SUMS
sha256sum --check SHA256SUMS
