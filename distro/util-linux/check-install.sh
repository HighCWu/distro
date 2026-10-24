#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Build-time ABI inspection only; never executes target utilities.
set -euo pipefail
[[ $# -ge 8 ]]
package_root=$1
support_root=$2
file_module=$3
busybox_module=$4
bits=$5
maximum=$6
parser=$7
checker=$8
shift 8
[[ $bits == 32 || $bits == 64 ]]
[[ -d $package_root && -d $support_root ]]
manifest=$(mktemp)
trap 'rm -f -- "$manifest"' EXIT

verify() {
  node "$checker" "$parser" "$1" "$bits" "$maximum"
}

wasm_modules=0
find "$package_root" "$support_root" -type f -print0 >"$manifest"
while IFS= read -r -d '' module; do
  signature=$(od -An -tx1 -N4 "$module" | tr -d ' \n')
  case $signature in
  0061736d)
    verify "$module"
    wasm_modules=$((wasm_modules + 1))
    ;;
  7f454c46)
    echo "util-linux: unexpected ELF payload: $module" >&2
    exit 1
    ;;
  esac
done <"$manifest"
[[ $wasm_modules -gt 0 ]]
verify "$file_module"
verify "$busybox_module"
for archive_root in "$package_root" "$@"; do
  [[ -d $archive_root ]]
  find "$archive_root" -type f -name '*.a' -print0 >"$manifest"
  while IFS= read -r -d '' archive; do
    headers=$("${LLVM_READOBJ:-llvm-readobj}" --file-headers "$archive")
    # Inspect every member; a single matching object must not hide a mixed
    # archive. LLVM reports Wasm address size from the object's real features.
    if ! printf '%s\n' "$headers" | awk -v bits="$bits" '
      /^Format: / { formats++; if ($2 != "WASM") bad=1 }
      /^Arch: / { arches++; if ($2 != "wasm" bits) bad=1 }
      /^AddressSize: / { sizes++; if ($2 != bits "bit") bad=1 }
      END { exit (bad || !formats || formats != arches || formats != sizes) }
    '; then
      echo "util-linux: archive members are not all wasm$bits: $archive" >&2
      exit 1
    fi
  done <"$manifest"
done
echo 'util-linux: final executable/helper and runtime dependency memory ABI verified'
