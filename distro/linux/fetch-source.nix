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
  # GitHub can rate-limit concurrent public runners. Keep retries spaced and
  # bounded rather than immediately exhausting both identical-tree mirrors.
  # This bounds the retry window, not the duration of a successful transfer.
  curlOptsList = [
    "--retry"
    "5"
    "--retry-delay"
    "15"
    "--retry-max-time"
    "180"
  ];
  # Both endpoints serve the same pinned tree. The unpacked hash remains
  # mandatory; fallback must never accept a different revision or contents.
  # Bypass github.com's archive redirect first, but retain it as a fallback.
  urls = [
    "https://codeload.github.com/${owner}/${repo}/tar.gz/${rev}"
    "https://github.com/${owner}/${repo}/archive/${rev}.tar.gz"
  ];
}
