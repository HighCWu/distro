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
    pkgs.runCommand "mincore-nommu-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "mincore-nommu-${platform.wasmArch}";
          init = "${program}/mincore-nommu.wasm";
        };
      }
      ''
        mkdir -p $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/mincore-nommu.wasm
        chmod 0755 $out/mincore-nommu.wasm
      '';
in
program
