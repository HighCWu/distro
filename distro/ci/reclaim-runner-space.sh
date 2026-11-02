#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

reclaim_dry_run=false
if [[ $# -gt 1 ]]; then
  echo 'Usage: reclaim-runner-space.sh [--dry-run]' >&2
  exit 64
fi
if [[ $# -eq 1 ]]; then
  if [[ $1 != --dry-run ]]; then
    echo 'Usage: reclaim-runner-space.sh [--dry-run]' >&2
    exit 64
  fi
  reclaim_dry_run=true
fi

# Never operate on a developer checkout or a self-hosted machine. The heavy
# workflow uses ubuntu-24.04; its compilers and dependencies come from Nix.
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || ${RUNNER_OS:-} != Linux ]]; then
  echo 'Refusing cleanup outside a GitHub-hosted Linux Actions runner' >&2
  exit 78
fi

# Fixed image-owned toolchains only. Preserve the workspace, runner, tool
# cache, Nix store/GC roots, action caches, disks and uploaded build materials.
readonly reclaim_paths=(/usr/local/lib/android /usr/share/dotnet /opt/ghc)
df -h /
for reclaim_path in "${reclaim_paths[@]}"; do
  printf 'Unused hosted toolchain: %s\n' "$reclaim_path"
  if [[ $reclaim_dry_run == false ]]; then
    sudo rm -rf --one-file-system -- "$reclaim_path"
  fi
done
df -h /
