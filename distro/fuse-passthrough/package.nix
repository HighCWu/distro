# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
}:
let
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  program =
    pkgs.runCommand "fuse-passthrough-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fuse-passthrough-${platform.wasmArch}";
          init = "${program}/fuse-passthrough.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/fuse-passthrough.wasm
        chmod 0755 $out/fuse-passthrough.wasm
      '';
in
program
