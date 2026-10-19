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
  image,
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
        passthru.benchmarkAssets = import ./benchmark.nix {
          inherit
            pkgs
            lib
            platform
            sysroot
            llvm-toolchain
            sdk-fork-continuation
            kernel
            image
            ;
        };
        passthru.benchmarkProfileAssets = import ./benchmark.nix {
          inherit
            pkgs
            lib
            platform
            sysroot
            llvm-toolchain
            sdk-fork-continuation
            image
            ;
          kernel = kernel.override { forkProfileTest = true; };
          profile = true;
        };
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
        passthru.checks.signals =
          (vm-test.override {
            kernel = kernel.override { forkSignalTest = true; };
          }).rawInitramfsTest
            {
              name = "fork-signals-${platform.wasmArch}";
              init = "${program}/fork-signal.wasm";
              cpus = 2;
            };
        passthru.checks.resume-signals =
          (vm-test.override {
            kernel = kernel.override { forkResumeSignalTest = true; };
          }).rawInitramfsTest
            {
              name = "fork-resume-signals-${platform.wasmArch}";
              init = "${program}/fork-resume-signal.wasm";
              cpus = 2;
            };
        passthru.checks.child-signals =
          (vm-test.override {
            kernel = kernel.override { forkChildSignalTest = true; };
          }).rawInitramfsTest
            {
              name = "fork-child-signals-${platform.wasmArch}";
              init = "${program}/fork-child-signal.wasm";
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
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -c ${./signal-runtime.c} -o signal.o
        wasm-linux-fork-cc -pthread signal.o -o signal-linked.wasm
        wasm-linux-fork-finalize signal-linked.wasm $out/fork-signal.wasm
        chmod 0755 $out/fork-signal.wasm
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -DFORK_SIGNAL_AFTER_CLONE -c ${./signal-runtime.c} -o resume-signal.o
        wasm-linux-fork-cc -pthread resume-signal.o -o resume-signal-linked.wasm
        wasm-linux-fork-finalize resume-signal-linked.wasm $out/fork-resume-signal.wasm
        chmod 0755 $out/fork-resume-signal.wasm
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -DFORK_SIGNAL_CHILD -c ${./signal-runtime.c} -o child-signal.o
        wasm-linux-fork-cc -pthread child-signal.o -o child-signal-linked.wasm
        wasm-linux-fork-finalize child-signal-linked.wasm $out/fork-child-signal.wasm
        chmod 0755 $out/fork-child-signal.wasm
      '';
in
program
