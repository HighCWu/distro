# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-brk-syscall,
  llvm-toolchain,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "brk-syscall-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-brk-syscall
          pkgs.python3
        ];
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
        # The OOM assertion must observe the real allocator, not an optimizer's
        # removable malloc whose pointer is only compared with NULL.
        wasm-linux-cc -O2 -fno-builtin-malloc -pthread -Wall -Wextra -Werror -c ${./runtime.c} -o runtime.o
        python3 ${./check-object.py} ${llvm-toolchain}/bin/llvm-readobj runtime.o
        wasm-linux-cc -pthread runtime.o -o $out/brk-syscall.wasm
        chmod 0755 $out/brk-syscall.wasm
      '';
in
program
