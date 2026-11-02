# SPDX-License-Identifier: MIT
# Independent candidate; the ordinary compiler and runtime source pins stay put.
{ pkgs }:
pkgs.fetchFromGitHub {
  owner = "HighCWu";
  repo = "llvm-project";
  rev = "90352668f9244889a82254abf71ca9c46a2e8996";
  hash = "sha256-/l/16+htX8HXUrQS6ehSCpWr1Hc8Szl7awt5bpeqFNw=";
}
