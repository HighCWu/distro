# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Substituted by package.nix; executable-shaping flags must not reach -c/-E.
sdk_link=true
for sdk_arg in "$@"; do
  case "$sdk_arg" in
  -c | -S | -E | -M | -MM | -fsyntax-only | --version | -dumpmachine | -dumpversion | -print-* | --print-*)
    sdk_link=false
    ;;
  @*)
    echo 'SDK response files are not supported; pass compiler arguments directly' >&2
    exit 2
    ;;
  esac
done
if "$sdk_link"; then
  exec @compiler@ @compileFlags@ @linkFlags@ "$@"
else
  exec @compiler@ @compileFlags@ "$@"
fi
