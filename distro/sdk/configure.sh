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
exec @shell@ "$configure_script" --build=@build@ --host=@host@ "$@"
