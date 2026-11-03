# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-brk-syscall,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "brk-syscall-${platform.wasmArch}"
      {
        nativeBuildInputs = [ sdk-brk-syscall ];
        passthru.checks = {
          profile = sdk-brk-syscall.checks.profile;
          cxx-runtime = sdk-brk-syscall.checks.cxx-runtime;
          runtime = vm-test.rawInitramfsTest {
            name = "brk-syscall-${platform.wasmArch}";
            init = "${program}/brk-syscall.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir $out
        wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/brk-syscall.wasm
        chmod 0755 $out/brk-syscall.wasm
      '';
in
program
