# SPDX-License-Identifier: MIT
{
  lib,
  stdenv,
  linux,
  busybox,
  platform,
  vm-test,
}:
let
  probe = stdenv.mkDerivation {
    name = "virtual-network-probe-${platform.wasmArch}";
    meta.license = lib.licenses.mit;
    dontUnpack = true;
    buildPhase = ''
      $CC -I${linux.headers}/include -O2 -Wall -Wextra -Werror ${./tun.c} -o tun-probe
    '';
    installPhase = ''
      install -Dm755 tun-probe "$out/bin/tun-probe"
    '';
    passthru.checks.runtime = vm-test.installedTest {
      name = "virtual-network-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [ busybox ];
      files."/tun-probe" = {
        source = "${probe}/bin/tun-probe";
        mode = "0755";
      };
    };
  };
in
probe
