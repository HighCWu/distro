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
  playwright,
}:
let
  transformedKernel = import ./worker-bundle.nix {
    inherit pkgs kernel;
    transformOnly = true;
  };
  transformedFaultKernel = import ./worker-bundle.nix {
    inherit pkgs;
    kernel = kernel.override { copyFaultTest = true; };
    transformOnly = true;
  };
  transformedRuntime = (vm-test.override { kernel = transformedKernel; }).rawInitramfsTest {
    name = "fork-worker-transform-${platform.wasmArch}";
    init = "${program}/fork.wasm";
    files."/fork-exec" = "${program}/exec-child.wasm";
    cpus = 2;
  };
  transformedFaults = (vm-test.override { kernel = transformedFaultKernel; }).rawInitramfsTest {
    name = "fork-worker-transform-faults-${platform.wasmArch}";
    init = "${program}/fork-fault.wasm";
    cpus = 2;
  };
  bundledKernel = import ./worker-bundle.nix { inherit pkgs kernel; };
  bundledFaultKernel = import ./worker-bundle.nix {
    inherit pkgs;
    kernel = kernel.override { copyFaultTest = true; };
  };
  bundledRuntime = (vm-test.override { kernel = bundledKernel; }).rawInitramfsTest {
    name = "fork-worker-bundle-${platform.wasmArch}";
    init = "${program}/fork.wasm";
    files."/fork-exec" = "${program}/exec-child.wasm";
    cpus = 2;
  };
  bundledFaults = (vm-test.override { kernel = bundledFaultKernel; }).rawInitramfsTest {
    name = "fork-worker-bundle-faults-${platform.wasmArch}";
    init = "${program}/fork-fault.wasm";
    cpus = 2;
  };
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
        passthru.nativeComparisonAssets = import ./latency.nix {
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
        passthru.browserComparisonAssets = import ./latency-browser.nix {
          inherit pkgs lib playwright;
          assets = program.nativeComparisonAssets;
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
        passthru.benchmarkWorkerPairAssets =
          let
            bundledAssets = import ./benchmark.nix {
              inherit
                pkgs
                lib
                platform
                sysroot
                llvm-toolchain
                sdk-fork-continuation
                image
                ;
              kernel = bundledKernel;
            };
          in
          pkgs.runCommand "fork-worker-pair-assets-${platform.wasmArch}" { } ''
            # Correctness, real timeout rollback and recovery precede measurement.
            test -e ${bundledRuntime}
            test -e ${bundledFaults}
            mkdir $out
            ln -s ${program.benchmarkAssets} $out/baseline
            ln -s ${bundledAssets} $out/bundled
            cp ${./benchmark-pair.mjs} $out/benchmark-pair.mjs
            cp ${./benchmark-pair.js} $out/benchmark-pair.js
            cp ${./benchmark-contract.js} $out/benchmark-contract.js
            cp ${./benchmark-profile.js} $out/benchmark-profile.js
          '';
        passthru.benchmarkWorkerTransformAssets =
          let
            transformedAssets = import ./benchmark.nix {
              inherit
                pkgs
                lib
                platform
                sysroot
                llvm-toolchain
                sdk-fork-continuation
                image
                ;
              kernel = transformedKernel;
            };
            selection = pkgs.writeText "worker-transform-experiment.json" (
              builtins.toJSON {
                experiment = "worker-transform-v1";
                variant = "transformed";
              }
            );
          in
          pkgs.runCommand "fork-worker-transform-pair-assets-${platform.wasmArch}" { } ''
            test -e ${transformedRuntime}
            test -e ${transformedFaults}
            mkdir $out
            ln -s ${program.benchmarkAssets} $out/baseline
            ln -s ${transformedAssets} $out/transformed
            cp ${selection} $out/experiment.json
            cp ${./benchmark-pair.mjs} $out/benchmark-pair.mjs
            cp ${./benchmark-pair.js} $out/benchmark-pair.js
            cp ${./benchmark-contract.js} $out/benchmark-contract.js
            cp ${./benchmark-profile.js} $out/benchmark-profile.js
          '';
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fork-continuation-${platform.wasmArch}";
          init = "${program}/fork.wasm";
          files."/fork-exec" = "${program}/exec-child.wasm";
          cpus = 2;
        };
        passthru.checks.futex-isolation = vm-test.rawInitramfsTest {
          name = "futex-isolation-${platform.wasmArch}";
          init = "${program}/futex-isolation.wasm";
          cpus = 2;
        };
        passthru.checks.namespaces = vm-test.rawInitramfsTest {
          name = "namespaces-${platform.wasmArch}";
          init = "${program}/namespaces.wasm";
          cpus = 2;
        };
        passthru.checks.process-control = vm-test.rawInitramfsTest {
          name = "process-control-${platform.wasmArch}";
          init = "${program}/process-control.wasm";
          cpus = 2;
        };
        passthru.checks.process-vm = vm-test.rawInitramfsTest {
          name = "process-vm-${platform.wasmArch}";
          init = "${program}/process-vm.wasm";
          cpus = 2;
        };
        passthru.checks.ptrace = vm-test.rawInitramfsTest {
          name = "ptrace-${platform.wasmArch}";
          init = "${program}/ptrace.wasm";
          cpus = 2;
        };
        passthru.checks.ptrace-entry = vm-test.rawInitramfsTest {
          name = "ptrace-entry-${platform.wasmArch}";
          init = "${program}/ptrace-entry.wasm";
          cpus = 2;
        };
        passthru.checks.syscall-reentry = vm-test.rawInitramfsTest {
          name = "syscall-reentry-${platform.wasmArch}";
          init = "${program}/syscall-reentry.wasm";
          cpus = 2;
        };
        passthru.checks.exec-fd = vm-test.rawInitramfsTest {
          name = "exec-fd-${platform.wasmArch}";
          init = "${program}/exec-fd.wasm";
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
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./exec-fd.c} -o exec-fd-linked.wasm
        wasm-linux-fork-finalize exec-fd-linked.wasm $out/exec-fd.wasm
        chmod 0755 $out/exec-fd.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./process-control.c} -o process-control-linked.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./process-vm.c} -o process-vm-linked.wasm
        wasm-linux-fork-finalize process-vm-linked.wasm $out/process-vm.wasm
        chmod 0755 $out/process-vm.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./ptrace.c} -o ptrace-linked.wasm
        wasm-linux-fork-finalize ptrace-linked.wasm $out/ptrace.wasm
        chmod 0755 $out/ptrace.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./ptrace-entry.c} -o ptrace-entry-linked.wasm
        wasm-linux-fork-finalize ptrace-entry-linked.wasm $out/ptrace-entry.wasm
        chmod 0755 $out/ptrace-entry.wasm
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -Wl,--wrap=pthread_mutex_lock ${./syscall-reentry.c} -o syscall-reentry-linked.wasm
        wasm-linux-fork-finalize syscall-reentry-linked.wasm $out/syscall-reentry.wasm
        chmod 0755 $out/syscall-reentry.wasm
        wasm-linux-fork-finalize process-control-linked.wasm $out/process-control.wasm
        chmod 0755 $out/process-control.wasm
        # Build as an external SDK consumer: separate compilation and final
        # link, followed by a single whole-executable continuation transform.
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror -c ${./runtime.c} -o runtime.o
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror -c ${./raw-clone.c} -o raw-clone.o
        wasm-linux-fork-cc -pthread runtime.o raw-clone.o -o raw.wasm
        # A normal, untransformed executable with the DEFAULT libc. This tests
        # that exec discards the inherited continuation and initializes new TLS.
        clang ${helperFlags} -O2 -Wall -Wextra -Werror ${./exec-child.c} ${./raw-clone.c} -o $out/exec-child.wasm
        wasm-linux-fork-finalize raw.wasm $out/fork.wasm
        wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror ${./futex-isolation.c} -o futex-isolation-linked.wasm
        wasm-linux-fork-finalize futex-isolation-linked.wasm $out/futex-isolation.wasm
        chmod 0755 $out/futex-isolation.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./namespaces.c} -o namespaces-linked.wasm
        wasm-linux-fork-finalize namespaces-linked.wasm $out/namespaces.wasm
        chmod 0755 $out/namespaces.wasm
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
