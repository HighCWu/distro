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
  probe = stdenv.mkDerivation {
    name = "ninep-mount-${platform.wasmArch}";
    meta.license = lib.licenses.mit;
    dontUnpack = true;
    buildPhase = ''
      $CC -I${linux.headers}/include -O2 -Wall -Wextra -Werror ${./mount-fd.c} -o mount-fd
      $CC -O2 -Wall -Wextra -Werror ${./write-file.c} -o write-file
    '';
    installPhase = ''
      install -Dm755 mount-fd "$out/bin/mount-fd"
      install -Dm755 write-file "$out/bin/write-file"
    '';
    passthru.checks.runtime = vm-test.rawInitramfsTest {
      name = "ninep-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [ busybox ];
      files = {
        "/mount-fd" = "${probe}/bin/mount-fd";
        "/write-file" = "${probe}/bin/write-file";
      };
      ninepExport = exportDirectory;
      recordRuntimeLog = true;
    };
  };
in
probe
