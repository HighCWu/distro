# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  linux,
  busybox,
  platform,
  vm-test,
}:
let
  exportDirectory = pkgs.writeTextDir "message.txt" "linux-wasm 9p transport\n";
  exportName = pkgs.writeText "ninep-export-name" "${exportDirectory}\n";
  probe = stdenv.mkDerivation {
    name = "ninep-mount-${platform.wasmArch}";
    meta.license = lib.licenses.mit;
    dontUnpack = true;
    buildPhase = ''
      $CC -I${linux.headers}/include -O2 -Wall -Wextra -Werror ${./mount-fd.c} -o mount-fd
    '';
    installPhase = ''
      install -Dm755 mount-fd "$out/bin/mount-fd"
    '';
    passthru.checks.runtime = vm-test.rawInitramfsTest {
      name = "ninep-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [ busybox ];
      files = {
        "/mount-fd" = "${probe}/bin/mount-fd";
        "/ninep-export-name" = exportName;
      };
      ninepExport = exportDirectory;
      recordRuntimeLog = true;
    };
  };
in
probe
