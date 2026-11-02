# SPDX-License-Identifier: MIT
{
  pkgs,
  owner,
  repo,
  rev,
  hash,
}:
assert builtins.match "[0-9a-f]{40}" rev != null;
pkgs.fetchgit {
  name = "source";
  inherit rev hash;
  # Both archive endpoints returned 429 for the pinned kernel in public CI.
  # Git serves the same immutable source without that archive endpoint. Keep
  # the independently verified recursive content hash, not a new unchecked
  # checkout hash. Nix must reject any differing files, modes or symlinks.
  url = "https://github.com/${owner}/${repo}.git";
  fetchSubmodules = false;
  leaveDotGit = false;
}
