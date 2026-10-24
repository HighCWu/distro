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
    pkgs.runCommand "clone-arguments-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "clone-arguments-${platform.wasmArch}";
          init = "${program}/clone-arguments.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/clone-arguments.wasm
        chmod 0755 $out/clone-arguments.wasm
      '';
in
program
