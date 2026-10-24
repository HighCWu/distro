# SPDX-License-Identifier: MIT
{
  pkgs,
  sdk-fork-continuation,
  vm-test,
}:
let
  program =
    pkgs.runCommand "seccomp-strict"
      {
        nativeBuildInputs = [ sdk-fork-continuation ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "seccomp-strict";
          init = "${program}/seccomp-strict.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/seccomp-strict.wasm
        chmod 0755 $out/seccomp-strict.wasm
      '';
in
program
