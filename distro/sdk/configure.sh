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
# Never inherit a host site file. The installed default shares the distro's
# unsupported-capability policy; explicit target overrides remain available.
sdk_config_site=@configSite@
export CONFIG_SITE="${WASM_CONFIG_SITE:-$sdk_config_site}"
# Autoconf silently ignores missing site files and splits paths on whitespace.
# This entry point accepts one explicit file, not a list of optional policies.
if [[ $CONFIG_SITE == *[[:space:]]* ]]; then
  printf 'wasm-linux-configure: CONFIG_SITE must be one path without whitespace: %s\n' "$CONFIG_SITE" >&2
  exit 64
fi
if [[ ! -r $CONFIG_SITE || -d $CONFIG_SITE ]]; then
  printf 'wasm-linux-configure: CONFIG_SITE is not a readable file: %s\n' "$CONFIG_SITE" >&2
  exit 66
fi
exec @shell@ "$configure_script" --build=@build@ --host=@host@ "$@"
