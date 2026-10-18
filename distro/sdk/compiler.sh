# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Clang parses response files and applies $-prefixed configuration options only
# to linking jobs. Keep argument interpretation in the compiler, not this shim.
# Ambient compiler search paths commonly describe the build host. Target
# dependencies must be supplied explicitly (-I/-isystem/-L, including response
# files or build-system flags), not inherited from an unrelated host shell.
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH LIBRARY_PATH
exec @compiler@ @configArgument@ "$@"
