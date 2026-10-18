# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sysroot,
  llvm-toolchain,
  vm-test,
  sdk-fork-continuation,
  kernel,
}:
let
  helperFlags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  program =
    pkgs.runCommand "fork-continuation-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fork-continuation-${platform.wasmArch}";
          init = "${program}/fork.wasm";
          files."/fork-exec" = "${program}/exec-child.wasm";
          cpus = 2;
        };
        passthru.checks.faults =
          (vm-test.override {
            kernel = kernel.override { copyFaultTest = true; };
          }).rawInitramfsTest
            {
              name = "fork-faults-${platform.wasmArch}";
              init = "${program}/fork-fault.wasm";
              cpus = 2;
            };
      }
      ''
        mkdir -p $out
        clang --version
        # Build as an external SDK consumer: separate compilation and final
        # link, followed by a single whole-executable continuation transform.
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -c ${./runtime.c} -o runtime.o
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror -c ${./raw-clone.c} -o raw-clone.o
        wasm-linux-fork-cc -pthread runtime.o raw-clone.o -o raw.wasm
        # A normal, untransformed executable with the DEFAULT libc. This tests
        # that exec discards the inherited continuation and initializes new TLS.
        clang ${helperFlags} -O2 -Wall -Wextra -Werror ${./exec-child.c} ${./raw-clone.c} -o $out/exec-child.wasm
        wasm-linux-fork-finalize raw.wasm $out/fork.wasm
        chmod 0755 $out/fork.wasm
        chmod 0755 $out/exec-child.wasm
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -c ${./fault-runtime.c} -o fault.o
        wasm-linux-fork-cc -pthread fault.o -o fault-linked.wasm
        wasm-linux-fork-finalize fault-linked.wasm $out/fork-fault.wasm
        chmod 0755 $out/fork-fault.wasm
      '';
in
program
