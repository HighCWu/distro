# SPDX-License-Identifier: MIT
# shellcheck shell=bash
if [[ $# -eq 0 ]]; then
  printf 'usage: wasm-linux-configure CONFIGURE-SCRIPT [OPTIONS...]\n' >&2
  exit 64
fi
configure_script=$1
shift
export CC=@cc@
export CXX=@cxx@
export AR=@ar@
export RANLIB=@ranlib@
export NM=@nm@
export PKG_CONFIG=@pkgConfig@
export CONFIG_SHELL=@shell@
# Site answers must be explicitly selected for this target, not inherited
# from the build host or a system-wide configure cache.
export CONFIG_SITE="${WASM_CONFIG_SITE:-/dev/null}"
exec @shell@ "$configure_script" --build=@build@ --host=@host@ "$@"
