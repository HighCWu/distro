# SPDX-License-Identifier: MIT
# shellcheck shell=bash
# Query target metadata only; never inherit the host's search directories.
export PKG_CONFIG_SYSROOT_DIR=@sysroot@
# Separately staged target libraries may use absolute installation prefixes.
if [[ -n "${WASM_PKG_CONFIG_SYSROOT_DIR-}" ]]; then
  export PKG_CONFIG_SYSROOT_DIR="$WASM_PKG_CONFIG_SYSROOT_DIR"
fi
export PKG_CONFIG_LIBDIR=@libdir@
export PKG_CONFIG_PATH="${WASM_PKG_CONFIG_PATH-}"
exec @pkgConfig@ --static "$@"
