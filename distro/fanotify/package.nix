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
    pkgs.runCommand "fanotify-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fanotify-${platform.wasmArch}";
          init = "${program}/fanotify.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/fanotify.wasm
        chmod 0755 $out/fanotify.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/fanotify.wasm
      '';
in
program
