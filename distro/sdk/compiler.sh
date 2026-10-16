# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Clang parses response files and applies $-prefixed configuration options only
# to linking jobs. Keep argument interpretation in the compiler, not this shim.
exec @compiler@ @configArgument@ "$@"
