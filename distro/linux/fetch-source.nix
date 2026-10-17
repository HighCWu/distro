# SPDX-License-Identifier: MIT
{
  pkgs,
  owner,
  repo,
  rev,
  hash,
}:
assert builtins.match "[0-9a-f]{40}" rev != null;
pkgs.fetchzip {
  name = "source";
  inherit hash;
  extension = "tar.gz";
  stripRoot = true;
  # Both endpoints serve the same pinned tree. The unpacked hash remains
  # mandatory; fallback must never accept a different revision or contents.
  # Bypass github.com's archive redirect first, but retain it as a fallback.
  urls = [
    "https://codeload.github.com/${owner}/${repo}/tar.gz/${rev}"
    "https://github.com/${owner}/${repo}/archive/${rev}.tar.gz"
  ];
}
