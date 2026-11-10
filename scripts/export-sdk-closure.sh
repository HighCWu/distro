#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

sdk_path=""
profile=""
github_sha=""
output_dir=""

usage() {
  cat <<'EOF'
Usage: export-sdk-closure.sh --sdk-path /nix/store/PATH \
       --profile default-wasm64|dynamic-wasm64 --github-sha SHA \
       --output-dir DIRECTORY

Export one built public SDK and its Nix store closure as a zstd-compressed
nix-store archive. The profile is an allowlisted selector, not a Nix expression.
EOF
}

while (($#)); do
  case "$1" in
    --sdk-path)
      (($# >= 2)) || { usage >&2; exit 2; }
      sdk_path="$2"
      shift 2
      ;;
    --profile)
      (($# >= 2)) || { usage >&2; exit 2; }
      profile="$2"
      shift 2
      ;;
    --github-sha)
      (($# >= 2)) || { usage >&2; exit 2; }
      github_sha="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || { usage >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    -h|--help)
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
  *)
    printf 'unsupported SDK profile: %s\n' "$profile" >&2
    exit 2
    ;;
esac

store_hash='[0-9abcdfghijklmnpqrsvwxyz]{32}'
if [[ ! "$sdk_path" =~ ^/nix/store/${store_hash}-${expected_store_name}$ ]]; then
  printf 'SDK path does not match the selected public profile (%s): %s\n' \
    "$expected_store_name" "$sdk_path" >&2
  exit 2
fi
if [[ ! "$github_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'github SHA must be a full 40-character commit hash\n' >&2
  exit 2
fi
if [[ -z "$output_dir" ]]; then
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

mkdir -p -- "$output_dir"
closure_file="$(mktemp)"
archive_name="sdk-${profile}-${github_sha}.nar.zst"
manifest_name="sdk-${profile}-${github_sha}.json"
archive_tmp="$(mktemp "$output_dir/.sdk-closure.XXXXXX")"
manifest_tmp="$(mktemp "$output_dir/.sdk-manifest.XXXXXX")"
trap 'rm -f -- "$closure_file" "$archive_tmp" "$manifest_tmp"' EXIT

# The fixed store path must be registered, and the closure query must include
# it. The archive contains only paths returned by Nix, never workspace files.
nix-store -qR "$sdk_path" > "$closure_file"
mapfile -t closure_paths < "$closure_file"
if ((${#closure_paths[@]} == 0)); then
  printf 'Nix returned an empty SDK closure\n' >&2
  exit 1
fi

found_sdk=0
for store_path in "${closure_paths[@]}"; do
  if [[ ! "$store_path" =~ ^/nix/store/[0-9a-z]{32}-[^/[:space:]]+$ ]]; then
    printf 'Nix returned an invalid closure path: %s\n' "$store_path" >&2
    exit 1
  fi
  if [[ "$store_path" == "$sdk_path" ]]; then
    found_sdk=1
  fi
done
if ((found_sdk == 0)); then
  printf 'Nix closure did not include the requested SDK root\n' >&2
  exit 1
fi

# Keep the uncompressed NAR stream out of the filesystem. pipefail makes a
# failed export or compressor fail this step instead of producing a pass artifact.
nix-store --export "${closure_paths[@]}" | zstd --quiet --threads=2 --compress --stdout > "$archive_tmp"
archive_sha256="$(sha256sum "$archive_tmp" | cut -d ' ' -f 1)"

printf '{\n  "schemaVersion": 1,\n  "repositoryCommit": "%s",\n  "profile": "%s",\n  "sdkAttribute": "%s",\n  "sdkPath": "%s",\n  "closureArchive": "%s",\n  "closureSha256": "%s",\n  "closureStorePathCount": %s\n}\n' \
  "$github_sha" "$profile" "$sdk_attribute" "$sdk_path" "$archive_name" \
  "$archive_sha256" "${#closure_paths[@]}" > "$manifest_tmp"

mv -- "$archive_tmp" "$output_dir/$archive_name"
mv -- "$manifest_tmp" "$output_dir/$manifest_name"
printf 'exported %s store paths to %s/%s\n' "${#closure_paths[@]}" "$output_dir" "$archive_name"
