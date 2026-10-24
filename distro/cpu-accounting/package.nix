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
    pkgs.runCommand "cpu-accounting-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "cpu-accounting-${platform.wasmArch}";
          init = "${program}/cpu-accounting.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir -p $out
        clang ${flags} -O2 -pthread -Wall -Wextra -Werror \
          ${./runtime.c} -o $out/cpu-accounting.wasm
        chmod 0755 $out/cpu-accounting.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/cpu-accounting.wasm
      '';
in
program
