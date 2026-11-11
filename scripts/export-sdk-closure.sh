#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

sdk_path=""
profile=""
github_sha=""
output_dir=""
runtime_path=""
runtime_path_supplied=0
tooling_path=""
tooling_path_supplied=0
tooling_source_revision=""
tooling_source_revision_supplied=0

usage() {
  cat <<'EOF'
Usage: export-sdk-closure.sh --sdk-path /nix/store/PATH \
       --profile default-wasm64|dynamic-wasm64|linux64-abi-dynamic-wasm64 --github-sha SHA \
       --output-dir DIRECTORY [--runtime-path /nix/store/<hash>-linux-wasm-runtime-assets-wasm64]
       [--tooling-path /nix/store/<hash>-llvm-toolchain-development-VERSION \
        --tooling-source-revision 40_HEX_COMMIT]

Export one built public SDK and optionally its matching wasm64 runtime assets
and native Clang LibTooling development libraries as one zstd-compressed Nix
store closure. Selectors must be fixed store paths, not Nix expressions or
arbitrary directories.
EOF
}

while (($#)); do
  case "$1" in
  --sdk-path)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    sdk_path="$2"
    shift 2
    ;;
  --profile)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    profile="$2"
    shift 2
    ;;
  --github-sha)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    github_sha="$2"
    shift 2
    ;;
  --output-dir)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    output_dir="$2"
    shift 2
    ;;
  --runtime-path)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    if ((runtime_path_supplied)); then
      printf 'runtime path may only be supplied once\n' >&2
      exit 2
    fi
    runtime_path="$2"
    runtime_path_supplied=1
    shift 2
    ;;
  --tooling-path)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    if ((tooling_path_supplied)); then
      printf 'tooling path may only be supplied once\n' >&2
      exit 2
    fi
    tooling_path="$2"
    tooling_path_supplied=1
    shift 2
    ;;
  --tooling-source-revision)
    (($# >= 2)) || {
      usage >&2
      exit 2
    }
    if ((tooling_source_revision_supplied)); then
      printf 'tooling source revision may only be supplied once\n' >&2
      exit 2
    fi
    tooling_source_revision="$2"
    tooling_source_revision_supplied=1
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    printf 'unknown argument: %s\n' "$1" >&2
    usage >&2
    exit 2
    ;;
  esac
done

case "$profile" in
default-wasm64)
  sdk_attribute="sdk-wasm64"
  expected_store_name="linux-wasm-sdk-wasm64"
  ;;
dynamic-wasm64)
  sdk_attribute="sdk-dynamic-loader-wasm64"
  expected_store_name="linux-wasm-dynamic-sdk-wasm64"
  ;;
linux64-abi-dynamic-wasm64)
  sdk_attribute="linux64-abi-dynamic-wasm64.sdk"
  expected_store_name="linux-wasm-dynamic-sdk-wasm64"
  ;;
*)
  printf 'unsupported SDK profile: %s\n' "$profile" >&2
  exit 2
  ;;
esac

store_hash='[0-9abcdfghijklmnpqrsvwxyz]{32}'
if [[ ! $sdk_path =~ ^/nix/store/${store_hash}-${expected_store_name}$ ]]; then
  printf 'SDK path does not match the selected public profile (%s): %s\n' \
    "$expected_store_name" "$sdk_path" >&2
  exit 2
fi
if ((runtime_path_supplied)) &&
  [[ ! $runtime_path =~ ^/nix/store/${store_hash}-linux-wasm-runtime-assets-wasm64$ ]]; then
  printf 'runtime path must be the public wasm64 runtime-assets output: %s\n' \
    "$runtime_path" >&2
  exit 2
fi
if ((tooling_path_supplied != tooling_source_revision_supplied)); then
  printf 'tooling path and source revision must be supplied together\n' >&2
  exit 2
fi
if ((tooling_path_supplied)) &&
  [[ ! $tooling_path =~ ^/nix/store/${store_hash}-llvm-toolchain-development-[0-9][^/[:space:]]*$ ]]; then
  printf 'tooling path must be the public llvm-toolchain-development output: %s\n' \
    "$tooling_path" >&2
  exit 2
fi
if ((tooling_source_revision_supplied)) &&
  [[ ! $tooling_source_revision =~ ^[0-9a-f]{40}$ ]]; then
  printf 'tooling source revision must be a full 40-character commit hash\n' >&2
  exit 2
fi
if [[ ! $github_sha =~ ^[0-9a-f]{40}$ ]]; then
  printf 'github SHA must be a full 40-character commit hash\n' >&2
  exit 2
fi
if [[ -z $output_dir ]]; then
  printf 'output directory is required\n' >&2
  exit 2
fi
if ! command -v nix-store >/dev/null 2>&1; then
  printf 'nix-store is required\n' >&2
  exit 2
fi
if ! command -v zstd >/dev/null 2>&1; then
  printf 'zstd is required\n' >&2
  exit 2
fi
if ((tooling_path_supplied)); then
  if ! command -v readelf >/dev/null 2>&1; then
    printf 'readelf is required when exporting the LibTooling runtime\n' >&2
    exit 2
  fi
  [[ -d "$tooling_path/include" && -f "$tooling_path/include/clang/Tooling/Tooling.h" ]] || {
    printf 'tooling header tree is missing from %s\n' "$tooling_path" >&2
    exit 1
  }
  [[ -d "$tooling_path/lib" && -f "$tooling_path/lib/cmake/llvm/LLVMConfig.cmake" &&
    -f "$tooling_path/lib/cmake/clang/ClangConfig.cmake" ]] || {
    printf 'LLVM/Clang CMake package metadata is missing from %s\n' "$tooling_path" >&2
    exit 1
  }
fi

mkdir -p -- "$output_dir"
closure_file="$(mktemp)"
tooling_closure_file=""
tooling_clang_needed_file=""
tooling_llvm_needed_file=""
archive_name="sdk-${profile}-${github_sha}.nar.zst"
manifest_name="sdk-${profile}-${github_sha}.json"
if ((tooling_path_supplied)); then
  archive_name="sdk-${profile}-${github_sha}-tooling.nar.zst"
  manifest_name="sdk-${profile}-${github_sha}-tooling.json"
  tooling_closure_file="$(mktemp)"
  tooling_clang_needed_file="$(mktemp)"
  tooling_llvm_needed_file="$(mktemp)"
fi
archive_tmp="$(mktemp "$output_dir/.sdk-closure.XXXXXX")"
manifest_tmp="$(mktemp "$output_dir/.sdk-manifest.XXXXXX")"
cleanup() {
  rm -f -- "$closure_file" "$archive_tmp" "$manifest_tmp"
  if [[ -n $tooling_closure_file ]]; then
    rm -f -- "$tooling_closure_file" "$tooling_clang_needed_file" "$tooling_llvm_needed_file"
  fi
}
trap cleanup EXIT

# Fixed store paths must be registered, and the closure query must include all
# requested roots. The archive contains only paths returned by Nix, never
# workspace files.
roots=("$sdk_path")
if ((runtime_path_supplied)); then
  roots+=("$runtime_path")
fi
if ((tooling_path_supplied)); then
  roots+=("$tooling_path")
fi
nix-store -qR "${roots[@]}" >"$closure_file"
mapfile -t closure_paths <"$closure_file"
if ((${#closure_paths[@]} == 0)); then
  printf 'Nix returned an empty SDK closure\n' >&2
  exit 1
fi

found_sdk=0
found_runtime=0
found_tooling=0
for store_path in "${closure_paths[@]}"; do
  if [[ ! $store_path =~ ^/nix/store/[0-9a-z]{32}-[^/[:space:]]+$ ]]; then
    printf 'Nix returned an invalid closure path: %s\n' "$store_path" >&2
    exit 1
  fi
  if [[ $store_path == "$sdk_path" ]]; then
    found_sdk=1
  fi
  if ((runtime_path_supplied)) && [[ $store_path == "$runtime_path" ]]; then
    found_runtime=1
  fi
  if ((tooling_path_supplied)) && [[ $store_path == "$tooling_path" ]]; then
    found_tooling=1
  fi
done
if ((found_sdk == 0)); then
  printf 'Nix closure did not include the requested SDK root\n' >&2
  exit 1
fi
if ((runtime_path_supplied && found_runtime == 0)); then
  printf 'Nix closure did not include the requested runtime-assets root\n' >&2
  exit 1
fi
tooling_closure_paths=()
tooling_clang_library=""
tooling_llvm_library=""
tooling_clang_runpath=""
tooling_llvm_runpath=""
tooling_clang_needed=()
tooling_llvm_needed=()
if ((tooling_path_supplied)); then
  if ((found_tooling == 0)); then
    printf 'Nix closure did not include the requested LibTooling root\n' >&2
    exit 1
  fi

  shopt -s nullglob
  for candidate in "$tooling_path"/lib/libclang-cpp.so*; do
    if [[ -f $candidate ]]; then
      tooling_clang_library="$candidate"
      break
    fi
  done
  for candidate in "$tooling_path"/lib/libLLVM.so* "$tooling_path"/lib/libLLVM-*.so*; do
    if [[ -f $candidate ]]; then
      tooling_llvm_library="$candidate"
      break
    fi
  done
  shopt -u nullglob
  if [[ -z $tooling_clang_library || -z $tooling_llvm_library ]]; then
    printf 'shared clang-cpp and LLVM libraries are required in %s/lib\n' "$tooling_path" >&2
    exit 1
  fi

  nix-store -qR "$tooling_path" >"$tooling_closure_file"
  mapfile -t tooling_closure_paths <"$tooling_closure_file"
  if ((${#tooling_closure_paths[@]} == 0)); then
    printf 'Nix returned an empty LibTooling runtime closure\n' >&2
    exit 1
  fi
  for store_path in "${tooling_closure_paths[@]}"; do
    if [[ ! $store_path =~ ^/nix/store/[0-9a-z]{32}-[^/[:space:]]+$ ]]; then
      printf 'Nix returned an invalid LibTooling closure path: %s\n' "$store_path" >&2
      exit 1
    fi
    if ! grep -Fxq -- "$store_path" "$closure_file"; then
      printf 'combined export closure is missing a tooling dependency: %s\n' "$store_path" >&2
      exit 1
    fi
  done

  readelf -d "$tooling_clang_library" >/dev/null || {
    printf 'could not read dynamic dependencies from %s\n' "$tooling_clang_library" >&2
    exit 1
  }
  readelf -d "$tooling_llvm_library" >/dev/null || {
    printf 'could not read dynamic dependencies from %s\n' "$tooling_llvm_library" >&2
    exit 1
  }
  tooling_clang_runpath="$(readelf -d "$tooling_clang_library" |
    awk -F'[][]' '/\((RUNPATH|RPATH)\)/ && NF >= 2 { print $2; exit }')"
  tooling_llvm_runpath="$(readelf -d "$tooling_llvm_library" |
    awk -F'[][]' '/\((RUNPATH|RPATH)\)/ && NF >= 2 { print $2; exit }')"
  readelf -d "$tooling_clang_library" |
    awk -F'[][]' '/\(NEEDED\)/ && NF >= 2 { print $2 }' | sort -u >"$tooling_clang_needed_file"
  readelf -d "$tooling_llvm_library" |
    awk -F'[][]' '/\(NEEDED\)/ && NF >= 2 { print $2 }' | sort -u >"$tooling_llvm_needed_file"
  mapfile -t tooling_clang_needed <"$tooling_clang_needed_file"
  mapfile -t tooling_llvm_needed <"$tooling_llvm_needed_file"
  if ((${#tooling_clang_needed[@]} == 0 || ${#tooling_llvm_needed[@]} == 0)); then
    printf 'could not read the shared-library NEEDED entries for the tooling libraries\n' >&2
    exit 1
  fi
  for soname in "${tooling_clang_needed[@]}" "${tooling_llvm_needed[@]}"; do
    if [[ ! $soname =~ ^[A-Za-z0-9_.+-]+$ ]]; then
      printf 'unexpected dynamic-library SONAME: %s\n' "$soname" >&2
      exit 1
    fi
  done
fi

json_quote() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}

# Keep the uncompressed NAR stream out of the filesystem. pipefail makes a
# failed export or compressor fail this step instead of producing a pass artifact.
nix-store --export "${closure_paths[@]}" | zstd --quiet --threads=2 --compress --stdout >"$archive_tmp"
archive_sha256="$(sha256sum "$archive_tmp" | cut -d ' ' -f 1)"
runtime_manifest_value=null
if ((runtime_path_supplied)); then
  runtime_manifest_value="\"$runtime_path\""
fi

if ((tooling_path_supplied)); then
  printf '{\n  "schemaVersion": 2,\n  "repositoryCommit": "%s",\n  "profile": "%s",\n  "sdkAttribute": "%s",\n  "sdkPath": "%s",\n  "runtimeAssetsPath": %s,\n  "closureArchive": "%s",\n  "closureSha256": "%s",\n  "closureStorePathCount": %s,\n' \
    "$github_sha" "$profile" "$sdk_attribute" "$sdk_path" "$runtime_manifest_value" \
    "$archive_name" "$archive_sha256" "${#closure_paths[@]}" >"$manifest_tmp"
  printf '  "tooling": {\n    "storePath": "%s",\n    "sourceRepository": "https://github.com/HighCWu/llvm-project",\n    "sourceRevision": "%s",\n    "includePath": "%s/include",\n    "libraryPath": "%s/lib",\n    "llvmCMakeConfig": "%s/lib/cmake/llvm/LLVMConfig.cmake",\n    "clangCMakeConfig": "%s/lib/cmake/clang/ClangConfig.cmake",\n    "cmakeLinkTargets": ["clang-cpp"],\n' \
    "$tooling_path" "$tooling_source_revision" "$tooling_path" "$tooling_path" \
    "$tooling_path" "$tooling_path" >>"$manifest_tmp"
  printf '    "sharedLibraries": {\n      "clang-cpp": {"path": "%s", "neededSonames": [' \
    "$tooling_clang_library" >>"$manifest_tmp"
  first=1
  for soname in "${tooling_clang_needed[@]}"; do
    if ((first)); then first=0; else printf ', ' >>"$manifest_tmp"; fi
    printf '"%s"' "$soname" >>"$manifest_tmp"
  done
  printf '], "rpath": %s},\n      "LLVM": {"path": "%s", "neededSonames": [' \
    "$(json_quote "$tooling_clang_runpath")" "$tooling_llvm_library" >>"$manifest_tmp"
  first=1
  for soname in "${tooling_llvm_needed[@]}"; do
    if ((first)); then first=0; else printf ', ' >>"$manifest_tmp"; fi
    printf '"%s"' "$soname" >>"$manifest_tmp"
  done
  printf '], "rpath": %s}\n    },\n    "runtimeClosureStorePaths": [' \
    "$(json_quote "$tooling_llvm_runpath")" >>"$manifest_tmp"
  first=1
  for store_path in "${tooling_closure_paths[@]}"; do
    if ((first)); then first=0; else printf ', ' >>"$manifest_tmp"; fi
    printf '"%s"' "$store_path" >>"$manifest_tmp"
  done
  printf ']\n  }\n}\n' >>"$manifest_tmp"
else
  printf '{\n  "schemaVersion": 1,\n  "repositoryCommit": "%s",\n  "profile": "%s",\n  "sdkAttribute": "%s",\n  "sdkPath": "%s",\n  "runtimeAssetsPath": %s,\n  "closureArchive": "%s",\n  "closureSha256": "%s",\n  "closureStorePathCount": %s\n}\n' \
    "$github_sha" "$profile" "$sdk_attribute" "$sdk_path" "$runtime_manifest_value" \
    "$archive_name" "$archive_sha256" "${#closure_paths[@]}" >"$manifest_tmp"
fi

mv -- "$archive_tmp" "$output_dir/$archive_name"
mv -- "$manifest_tmp" "$output_dir/$manifest_name"
printf 'exported %s store paths to %s/%s\n' "${#closure_paths[@]}" "$output_dir" "$archive_name"
