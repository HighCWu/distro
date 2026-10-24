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
    pkgs.runCommand "public-syscall-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "public-syscall-${platform.wasmArch}";
          init = "${program}/public-syscall.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/public-syscall.wasm
        chmod 0755 $out/public-syscall.wasm
      '';
in
program
