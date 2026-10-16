# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Query target metadata only; never inherit the host's search directories.
export PKG_CONFIG_SYSROOT_DIR=@sysroot@
export PKG_CONFIG_LIBDIR=@libdir@
export PKG_CONFIG_PATH="${WASM_PKG_CONFIG_PATH-}"
exec @pkgConfig@ --static "$@"
