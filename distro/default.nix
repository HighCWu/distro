# The wasm32 package scope. This attrset is the product: consumers import it,
# build their own packages with `callPackage`, and replace or extend members
# with `overrideScope`. Product-owned artifacts are nested under their owner;
# shared construction machinery lives under `image` and `vm-test`.
#
# Dependency provenance is explicit: build-platform packages come from `pkgs.*`,
# wasm packages come from the scope by bare name. Inside the scope, `stdenv`
# targets wasm32-unknown-linux-musl, so a package written for this scope looks
# exactly like a nixpkgs package.
{
  pkgs,
  debug ? false,
  sourceVersion ? "0",
}:

let
  inherit (pkgs) lib;
in

lib.makeScope (scope: lib.callPackageWith ({ inherit lib pkgs; } // scope)) (
  self:
  let
    inherit (self) callPackage;
    # Images embedded by lowland-boot cannot install from the final repository:
    # that repository contains lowland-boot itself. This private index is the
    # acyclic package-only input used to construct those images.
    bootstrapRepository = callPackage ./repository.nix { };
    vmTestWasm64 = callPackage ./vm-test/package.nix {
      kernel = self.kernel-wasm64;
      apk = self.apk-wasm64;
      image = self.image-wasm64;
    };
    linuxElfContainer = self.linux.override { elfContainerCandidate = true; };
    kernelElfContainer = self.kernel.override { linux = linuxElfContainer; };
    vmTestElfContainer = self.vm-test.override { kernel = kernelElfContainer; };
    linuxElfContainerWasm64 = self.linux-wasm64.override { elfContainerCandidate = true; };
    kernelElfContainerWasm64 = self.kernel-wasm64.override {
      linux = linuxElfContainerWasm64;
    };
    vmTestElfContainerWasm64 = vmTestWasm64.override {
      kernel = kernelElfContainerWasm64;
    };
    # Historical refusal controls use an explicitly closed kernel. They must
    # not redefine the ordinary runtime's file-mapping policy.
    vmTestClosed32 = self.vm-test.override {
      kernel = self.kernel.override {
        linux = self.linux.override {
          fileMmapCandidate = false;
          fileMmapStreamCandidate = false;
        };
      };
    };
    vmTestClosed64 = vmTestWasm64.override {
      kernel = self.kernel-wasm64.override {
        linux = self.linux-wasm64.override {
          fileMmapCandidate = false;
          fileMmapStreamCandidate = false;
        };
      };
    };
    vtimeVm32 = self.vm-test.override {
      kernel = self.kernel.override { linux = self.linux.override { vtimeCandidate = true; }; };
    };
    vtimeVm64 = vmTestWasm64.override {
      kernel = self.kernel-wasm64.override {
        linux = self.linux-wasm64.override { vtimeCandidate = true; };
      };
    };
    linuxCheckpointRestore32 = self.linux.override { checkpointRestoreCandidate = true; };
    kernelCheckpointRestore32 = self.kernel.override { linux = linuxCheckpointRestore32; };
    vmTestCheckpointRestore32 = self.vm-test.override { kernel = kernelCheckpointRestore32; };
    linuxCheckpointRestore64 = self.linux-wasm64.override { checkpointRestoreCandidate = true; };
    kernelCheckpointRestore64 = self.kernel-wasm64.override { linux = linuxCheckpointRestore64; };
    vmTestCheckpointRestore64 = vmTestWasm64.override { kernel = kernelCheckpointRestore64; };
    linuxNinep32 = self.linux.override { ninepCandidate = true; };
    linuxNinep64 = self.linux-wasm64.override { ninepCandidate = true; };
    prctlMmMapCheckpointRestore32 = callPackage ./prctl-mm-map/package.nix {
      vm-test = vmTestCheckpointRestore32;
    };
    prctlMmMapCheckpointRestore64 = callPackage ./prctl-mm-map/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestCheckpointRestore64;
    };
    prctlMmMapCheckpointRestoreBoth =
      pkgs.runCommand "prctl-mm-map-checkpoint-restore-both-widths"
        {
          passthru.ci.heavy = true;
        }
        ''
          test -e ${prctlMmMapCheckpointRestore32.checks.runtime}
          test -e ${prctlMmMapCheckpointRestore64.checks.runtime}
          touch $out
        '';
    vtimeChecks = harness: smoke: fork: {
      deferred-cancel = (smoke.override { vm-test = harness; }).checks.deferred-cancel;
      signal-altstack = (smoke.override { vm-test = harness; }).checks.signal-altstack;
      fork-runtime = (fork.override { vm-test = harness; }).checks.runtime;
    };
    stdenvReleaseWasm64 = import ./stdenv.nix {
      inherit pkgs;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
    };
    sharedDriverToolchain = self.llvm-toolchain-unwrapped.override {
      includeHostBackend = false;
      patches = [
        ./dynamic-loader/linux-shared.patch
        ./dynamic-loader/function-reexport-reader.patch
        ./dynamic-loader/function-reexports.patch
        ./dynamic-loader/wasm-pic-eh-context.patch
      ];
    };
  in
  {
    inherit debug sourceVersion;
    platform = callPackage ./platform.nix { };
    apk-tools-src = callPackage ./apk-tools/source.nix { };
    apk-tools-host = pkgs.apk-tools.overrideAttrs (_old: {
      version = "3.0.5";
      src = self.apk-tools-src;
    });
    apk = callPackage ./apk {
      tools = self.apk-tools-host;
    };

    # The toolchain bootstrap. These build with the build platform's stdenv and
    # explicit flags because they exist to produce the wasm stdenv below; they
    # must not consume it.
    llvm-toolchain-unwrapped = callPackage ./llvm-toolchain/unwrapped.nix {
    };
    # Opt-in host development libraries for embedding Clang LibTooling. The
    # ordinary SDK toolchain above remains static and unchanged.
    llvm-toolchain-development = self.llvm-toolchain-unwrapped.override {
      includeHostBackend = false;
      enableLibTooling = true;
    };
    clang-tooling-check = callPackage ./clang-tooling-check/package.nix {
      llvmToolchain = self.llvm-toolchain-development;
      sysroot32 = self.sysroot;
      sysroot64 = self.sysroot-wasm64;
    };
    platform-wasm64 = callPackage ./platform.nix { wasmBits = 64; };
    linux = callPackage ./linux/package.nix { };
    linux-wasm64 = self.linux.override { wasmBits = 64; };
    linux-checkpoint-restore = linuxCheckpointRestore32;
    linux-checkpoint-restore-wasm64 = linuxCheckpointRestore64;
    bytes = callPackage ./npm/bytes.nix { };
    kernel = callPackage ./npm/kernel.nix { };
    kernel-wasm64 = self.kernel.override { linux = self.linux-wasm64; };
    kernel-checkpoint-restore = kernelCheckpointRestore32;
    kernel-checkpoint-restore-wasm64 = kernelCheckpointRestore64;
    vm-test-checkpoint-restore = vmTestCheckpointRestore32;
    vm-test-checkpoint-restore-wasm64 = vmTestCheckpointRestore64;
    runtime-assets-wasm64 = callPackage ./runtime-assets/package.nix {
      platform = self.platform-wasm64;
      kernel = self.kernel-wasm64;
      vm-test = vmTestWasm64;
    };
    musl = callPackage ./musl/package.nix { };
    musl-wasm64 = self.musl.override { wasmBits = 64; };
    sysroot-base = callPackage ./sysroot-base/package.nix { };
    sysroot-base-wasm64 = callPackage ./sysroot-base/package.nix {
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
      musl = self.musl-wasm64;
    };
    llvm-runtimes = callPackage ./llvm-runtimes/package.nix { };
    llvm-runtimes-wasm64 = callPackage ./llvm-runtimes/package.nix {
      platform = self.platform-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
    };
    sysroot = callPackage ./sysroot/package.nix { };
    sysroot-wasm64 = callPackage ./sysroot/package.nix {
      platform = self.platform-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
    };
    llvm-toolchain = callPackage ./llvm-toolchain/package.nix { };
    llvm-toolchain-wasm64 = callPackage ./llvm-toolchain/package.nix {
      platform = self.platform-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
    };
    toolchain-smoke = callPackage ./toolchain-smoke/package.nix {
      extraChecks.madvise-free-both =
        pkgs.runCommand "madvise-free-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.toolchain-smoke.checks.madvise}
            test -e ${self.toolchain-smoke-wasm64.checks.madvise}
            test -e ${self.file-mmap-stream.checks.runtime}
            test -e ${self.file-mmap-stream-wasm64.checks.runtime}
            touch $out
          '';
    };
    sdk = callPackage ./sdk/package.nix { };
    sdk-elf-container = self.sdk.override {
      elfContainer = true;
      vm-test = vmTestElfContainer;
    };
    fork-memory-advice = callPackage ./fork-memory-advice/package.nix {
      extraChecks.both =
        pkgs.runCommand "fork-memory-advice-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.fork-memory-advice.checks.runtime}
            test -e ${self.fork-memory-advice-wasm64.checks.runtime}
            test -e ${self.fork-continuation.checks.runtime}
            test -e ${self.fork-continuation-wasm64.checks.runtime}
            test -e ${self.toolchain-smoke.checks.madvise}
            test -e ${self.toolchain-smoke-wasm64.checks.madvise}
            touch $out
          '';
    };
    fork-memory-advice-wasm64 = callPackage ./fork-memory-advice/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    mremap-dontunmap = callPackage ./mremap-dontunmap/package.nix {
      extraChecks.both = pkgs.runCommand "mremap-dontunmap-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.mremap-dontunmap.checks.runtime}
        test -e ${self.mremap-dontunmap-wasm64.checks.runtime}
        test -e ${self.toolchain-smoke.checks.mremap}
        test -e ${self.toolchain-smoke-wasm64.checks.mremap}
        touch $out
      '';
    };
    mremap-dontunmap-wasm64 = callPackage ./mremap-dontunmap/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    sdk-dynamic-loader = callPackage ./dynamic-loader/sdk.nix {
      sharedCompiler = sharedDriverToolchain;
    };
    sdk-dynamic-loader-wasm64 = callPackage ./dynamic-loader/sdk.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
      sysroot = self.sysroot-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sdk = self.sdk-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      sharedCompiler = sharedDriverToolchain;
    };
    dynamic-loader = callPackage ./dynamic-loader/package.nix {
      extraChecks.sdk-both = pkgs.runCommand "dynamic-sdk-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.sdk-dynamic-loader.checks.driver}
        test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
        test -e ${self.dynamic-driver.checks.build}
        test -e ${self.dynamic-loader.checks.runtime}
        test -e ${self.dynamic-loader-wasm64.checks.runtime}
        touch $out
      '';
      extraChecks.link-driver-both =
        pkgs.runCommand "sdk-link-driver-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.sdk.checks.link-driver}
            test -e ${self.sdk-wasm64.checks.link-driver}
            test -e ${self.dynamic-driver.checks.build}
            test -e ${self.sdk.checks.cxx-runtime}
            test -e ${self.sdk-wasm64.checks.cxx-runtime}
            touch $out
          '';
    };
    dynamic-symbol-versions = callPackage ./dynamic-symbol-versions/package.nix { };
    dynamic-symbol-versions-wasm64 = callPackage ./dynamic-symbol-versions/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    dynamic-driver = callPackage ./dynamic-loader/driver.nix {
      compiler = sharedDriverToolchain;
    };
    dynamic-loader-driver = self.dynamic-loader.override {
      sharedCompiler = sharedDriverToolchain;
    };
    dynamic-loader-driver-wasm64 = self.dynamic-loader-wasm64.override {
      sharedCompiler = sharedDriverToolchain;
    };
    dynamic-loader-wasm64 = callPackage ./dynamic-loader/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    elf-container = callPackage ./elf-container/package.nix {
      inherit (self) sdk-elf-container;
      vm-test = vmTestElfContainer;
      extraChecks.both =
        pkgs.runCommand "elf-container-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-elf-container.checks.link-driver}
            test -e ${self.sdk-elf-container-wasm64.checks.link-driver}
            test -e ${self.elf-container.checks.runtime}
            test -e ${self.elf-container-wasm64.checks.runtime}
            touch $out
          '';
    };
    elf-container-wasm64 = callPackage ./elf-container/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-elf-container = self.sdk-elf-container-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestElfContainerWasm64;
      busybox = self.busybox-wasm64;
    };
    libltdl = callPackage ./libltdl/package.nix { };
    libltdl-wasm64 = callPackage ./libltdl/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
    };
    libltdl-runtime = callPackage ./libltdl-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "libltdl-runtime-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.libltdl-runtime.checks.runtime}
            test -e ${self.libltdl-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    libltdl-runtime-wasm64 = callPackage ./libltdl-runtime/package.nix {
      platform = self.platform-wasm64;
      libltdl = self.libltdl-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    sdk-wasm64 = callPackage ./sdk/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    linux64-abi-wasm64 = callPackage ./linux64-abi/package.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    linux64-abi-dynamic-wasm64 = callPackage ./linux64-abi/dynamic.nix {
      linux64Abi = self.linux64-abi-wasm64;
      vm-test = vmTestWasm64;
      sharedCompiler = sharedDriverToolchain;
    };
    sdk-elf-container-wasm64 = self.sdk-wasm64.override {
      elfContainer = true;
      vm-test = vmTestElfContainerWasm64;
    };
    toolchain-smoke-runtime = self.toolchain-smoke.checks.c-runtime;
    toolchain-smoke-wasm64 = callPackage ./toolchain-smoke/package.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    toolchain-smoke-runtime-wasm64 = self.toolchain-smoke-wasm64.checks.c-runtime;
    symbol-versions = callPackage ./symbol-versions/package.nix {
      inherit (self) sdk;
      extraChecks.both =
        pkgs.runCommand "symbol-versions-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            # Verify the ordinary SDK and its runtimes at both widths together.
            test -e ${self.symbol-versions.checks.profile}
            test -e ${self.symbol-versions-wasm64.checks.profile}
            test -e ${self.symbol-versions.checks.cxx-runtime}
            test -e ${self.symbol-versions-wasm64.checks.cxx-runtime}
            test -e ${self.symbol-versions.checks.runtime}
            test -e ${self.symbol-versions-wasm64.checks.runtime}
            touch $out
          '';
    };
    symbol-versions-wasm64 = callPackage ./symbol-versions/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    landlock = callPackage ./landlock/package.nix { };
    user-namespace = callPackage ./user-namespace/package.nix {
      vm-test = self.vm-test.override {
        kernel = self.kernel.override {
          linux = self.linux.override { userNamespaceCandidate = true; };
        };
      };
      extraChecks.both = pkgs.runCommand "user-namespace-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.user-namespace.checks.runtime}
        test -e ${self.user-namespace-wasm64.checks.runtime}
        touch $out
      '';
    };
    user-namespace-wasm64 = callPackage ./user-namespace/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override { userNamespaceCandidate = true; };
        };
      };
    };
    sdk-cooperative-poll = callPackage ./cooperative-poll/sdk.nix { };
    exec-thread-state = callPackage ./exec-thread-state/package.nix {
      extraChecks.both = pkgs.runCommand "exec-thread-state-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.exec-thread-state.checks.runtime}
        test -e ${self.exec-thread-state-wasm64.checks.runtime}
        test -e ${self.cooperative-poll.checks.runtime}
        test -e ${self.cooperative-poll-wasm64.checks.runtime}
        test -e ${self.fork-continuation.checks.exec-fd}
        test -e ${self.fork-continuation-wasm64.checks.exec-fd}
        touch $out
      '';
    };
    thread-timer = callPackage ./thread-timer/package.nix {
      extraChecks.both = pkgs.runCommand "thread-timer-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.thread-timer.checks.runtime}
        test -e ${self.thread-timer-wasm64.checks.runtime}
        test -e ${self.thread-timer-libc.checks.runtime}
        test -e ${self.thread-timer-libc-wasm64.checks.runtime}
        test -e ${self.cooperative-poll.checks.runtime}
        test -e ${self.cooperative-poll-wasm64.checks.runtime}
        touch $out
      '';
    };
    thread-timer-wasm64 = callPackage ./thread-timer/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    thread-timer-libc = self.thread-timer.override {
      sdk = self.sdk-cooperative-poll-libc;
      libraryCoverage = true;
      extraChecks = { };
    };
    thread-timer-libc-wasm64 = self.thread-timer-wasm64.override {
      sdk = self.sdk-cooperative-poll-libc-wasm64;
      libraryCoverage = true;
    };
    exec-thread-state-wasm64 = callPackage ./exec-thread-state/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
    };
    exec-imports = callPackage ./exec-imports/package.nix {
      extraChecks.both = pkgs.runCommand "exec-imports-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.exec-imports.checks.runtime}
        test -e ${self.exec-imports-wasm64.checks.runtime}
        touch $out
      '';
    };
    exec-imports-wasm64 = callPackage ./exec-imports/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    kernel-robust = callPackage ./kernel-robust/package.nix {
      extraChecks.both = pkgs.runCommand "kernel-robust-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.kernel-robust.checks.runtime}
        test -e ${self.kernel-robust-wasm64.checks.runtime}
        touch $out
      '';
    };
    kernel-robust-wasm64 = callPackage ./kernel-robust/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    sdk-cooperative-poll-wasm64 = callPackage ./cooperative-poll/sdk.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk = self.sdk-wasm64;
      musl = self.musl-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
    };
    sdk-cooperative-poll-libc = self.sdk-cooperative-poll.override { libraryCoverage = true; };
    sdk-cooperative-poll-libc-wasm64 = self.sdk-cooperative-poll-wasm64.override {
      libraryCoverage = true;
    };
    cooperative-poll-libc = self.cooperative-poll.override {
      libraryCoverage = true;
      sdk-cooperative-poll = self.sdk-cooperative-poll-libc;
      extraChecks.both =
        pkgs.runCommand "cooperative-poll-libc-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.cooperative-poll-libc.checks.runtime}
            test -e ${self.cooperative-poll-libc-wasm64.checks.runtime}
            touch $out
          '';
    };
    cooperative-poll-libc-wasm64 = self.cooperative-poll-wasm64.override {
      libraryCoverage = true;
      sdk-cooperative-poll = self.sdk-cooperative-poll-libc-wasm64;
    };
    cooperative-poll = callPackage ./cooperative-poll/package.nix {
      extraChecks.both =
        pkgs.runCommand "cooperative-poll-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.cooperative-poll.checks.runtime}
            test -e ${self.cooperative-poll-wasm64.checks.runtime}
            touch $out
          '';
    };
    cooperative-poll-wasm64 = callPackage ./cooperative-poll/package.nix {
      platform = self.platform-wasm64;
      sdk-cooperative-poll = self.sdk-cooperative-poll-wasm64;
      vm-test = vmTestWasm64;
    };
    cooperative-poll-cpu = self.cooperative-poll.override {
      vm-test = vtimeVm32;
      cpuTimers = true;
      extraChecks.both =
        pkgs.runCommand "cooperative-poll-cpu-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.cooperative-poll.checks.runtime}
            test -e ${self.cooperative-poll-wasm64.checks.runtime}
            test -e ${self.cooperative-poll-cpu.checks.runtime}
            test -e ${self.cooperative-poll-cpu-wasm64.checks.runtime}
            touch $out
          '';
    };
    cooperative-poll-cpu-wasm64 = self.cooperative-poll-wasm64.override {
      vm-test = vtimeVm64;
      cpuTimers = true;
    };
    sdk-brk-syscall = callPackage ./brk-syscall/sdk.nix { };
    brk-syscall = callPackage ./brk-syscall/package.nix {
      extraChecks.runtime-both =
        pkgs.runCommand "brk-syscall-runtime-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.brk-syscall.checks.runtime}
            test -e ${self.brk-syscall-wasm64.checks.runtime}
            touch $out
          '';
      extraChecks.both =
        pkgs.runCommand "brk-syscall-both-widths"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.brk-syscall.checks.profile}
            test -e ${self.brk-syscall-wasm64.checks.profile}
            test -e ${self.brk-syscall.checks.cxx-runtime}
            test -e ${self.brk-syscall-wasm64.checks.cxx-runtime}
            test -e ${self.brk-syscall.checks.runtime}
            test -e ${self.brk-syscall-wasm64.checks.runtime}
            # Reuse one build graph for the changed kernel/libc combination.
            test -e ${self.landlock.checks.runtime}
            test -e ${self.landlock-wasm64.checks.runtime}
            test -e ${self.symbol-versions.checks.both}
            test -e ${self.fork-continuation.checks.runtime}
            test -e ${self.fork-continuation-wasm64.checks.runtime}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            test -e ${self.dynamic-symbol-versions.checks.runtime}
            test -e ${self.dynamic-symbol-versions-wasm64.checks.runtime}
            test -e ${self.toolchain-smoke.checks.madvise-free-both}
            touch $out
          '';
    };
    brk-syscall-wasm64 = callPackage ./brk-syscall/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sdk-brk-syscall = self.sdk-brk-syscall-wasm64;
      vm-test = vmTestWasm64;
    };
    sdk-brk-syscall-wasm64 = callPackage ./brk-syscall/sdk.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk = self.sdk-wasm64;
    };
    landlock-wasm64 = callPackage ./landlock/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    public-syscall = callPackage ./public-syscall/package.nix { };
    signal-syscall-context = callPackage ./signal-syscall-context/package.nix {
      extraChecks.both =
        pkgs.runCommand "signal-syscall-context-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.signal-syscall-context.checks.runtime}
            test -e ${self.signal-syscall-context-wasm64.checks.runtime}
            touch $out
          '';
    };
    signal-syscall-context-wasm64 = self.signal-syscall-context.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fuse-passthrough = callPackage ./fuse-passthrough/package.nix { };
    procps-vmstat = callPackage ./procps-vmstat/package.nix { };
    procps-vmstat-wasm64 = callPackage ./procps-vmstat/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
    };
    vm-events = callPackage ./vm-events/package.nix { };
    direct-io = callPackage ./direct-io/package.nix { };
    packet-sockets = callPackage ./packet-sockets/package.nix { };
    ipv4-multicast = callPackage ./ipv4-multicast/package.nix { };
    ipv4-multicast-wasm64 = self.ipv4-multicast.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    ipv4-multipath = callPackage ./ipv4-multipath/package.nix { };
    ipv4-multipath-wasm64 = callPackage ./ipv4-multipath/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    ipv6-source-route = callPackage ./ipv6-source-route/package.nix { };
    ipv6-source-route-wasm64 = callPackage ./ipv6-source-route/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    virtual-network = callPackage ./virtual-network/package.nix { };
    autofs-runtime = callPackage ./autofs-runtime/package.nix { };
    vsock-runtime = callPackage ./vsock-runtime/package.nix { };
    ninep = callPackage ./ninep/package.nix {
      linux = linuxNinep32;
      vm-test = self.vm-test.override {
        kernel = self.kernel.override { linux = linuxNinep32; };
      };
    };
    key-dh-runtime = callPackage ./key-dh-runtime/package.nix { };
    key-dh-runtime-wasm64 = self.key-dh-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    key-pkey-runtime = callPackage ./key-pkey-runtime/package.nix { };
    key-pkey-runtime-wasm64 = self.key-pkey-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    key-watch-runtime = callPackage ./key-watch-runtime/package.nix { };
    key-watch-runtime-wasm64 = self.key-watch-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    alg-hash = callPackage ./alg-hash/package.nix { };
    iproute2-ss = callPackage ./iproute2-ss/package.nix { };
    iproute2-ss-wasm64 = callPackage ./iproute2-ss/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
    };
    setsid-fork = callPackage ./util-linux-fork/package.nix {
      program = "setsid";
      runtimeSource = ./setsid-fork/runtime.c;
      initSource = ./setsid-fork/runtime-test.sh;
    };
    setsid-fork-wasm64 = callPackage ./util-linux-fork/package.nix {
      program = "setsid";
      runtimeSource = ./setsid-fork/runtime.c;
      initSource = ./setsid-fork/runtime-test.sh;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    flock-fork = callPackage ./util-linux-fork/package.nix {
      program = "flock";
      runtimeSource = ./flock-fork/runtime.c;
      initSource = ./flock-fork/runtime-test.sh;
    };
    flock-fork-wasm64 = callPackage ./util-linux-fork/package.nix {
      program = "flock";
      runtimeSource = ./flock-fork/runtime.c;
      initSource = ./flock-fork/runtime-test.sh;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    cgroup-pids = callPackage ./cgroup-pids/package.nix { };
    cgroup-pids-wasm64 = callPackage ./cgroup-pids/package.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    cgroup-io = callPackage ./cgroup-io/package.nix { };
    cgroup-io-wasm64 = self.cgroup-io.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    cgroup-cpuacct = callPackage ./cgroup-cpuacct/package.nix { };
    cgroup-cpuacct-wasm64 = callPackage ./cgroup-cpuacct/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    prctl-mm-map-checkpoint-restore = prctlMmMapCheckpointRestore32.override {
      extraChecks.both = prctlMmMapCheckpointRestoreBoth;
    };
    prctl-mm-map-checkpoint-restore-wasm64 = prctlMmMapCheckpointRestore64;
    bpf-syscall = callPackage ./bpf-syscall/package.nix { };
    bpf-nofault = self.bpf-syscall.override {
      pname = "bpf-nofault";
      runtimeSource = ./bpf-syscall/nofault.c;
      initSource = ./bpf-syscall/nofault-test.sh;
    };
    bpf-nofault-wasm64 = self.bpf-syscall-wasm64.override {
      pname = "bpf-nofault";
      runtimeSource = ./bpf-syscall/nofault.c;
      initSource = ./bpf-syscall/nofault-test.sh;
    };
    bpf-syscall-wasm64 = callPackage ./bpf-syscall/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    socket-diag = callPackage ./socket-diag/package.nix { };
    socket-diag-wasm64 = callPackage ./socket-diag/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      iproute2-ss = self.iproute2-ss-wasm64;
      vm-test = vmTestWasm64;
    };
    alg-rng = callPackage ./alg-rng/package.nix { };
    alg-rng-wasm64 = callPackage ./alg-rng/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    alg-aead = callPackage ./alg-aead/package.nix { };
    alg-aead-wasm64 = callPackage ./alg-aead/package.nix {
      alg-hash = self.alg-hash-wasm64;
      alg-skcipher = self.alg-skcipher-wasm64;
      netlink-crypto = self.netlink-crypto-wasm64;
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    netlink-crypto = callPackage ./netlink-crypto/package.nix { };
    netlink-crypto-wasm64 = callPackage ./netlink-crypto/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    alg-skcipher = callPackage ./alg-skcipher/package.nix { };
    alg-skcipher-wasm64 = callPackage ./alg-skcipher/package.nix {
      alg-hash = self.alg-hash-wasm64;
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    alg-hash-wasm64 = callPackage ./alg-hash/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    libkcapi = callPackage ./libkcapi/package.nix { };
    libkcapi-wasm64 = callPackage ./libkcapi/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
    };
    crypto-tools = (callPackage ./crypto-tools/package.nix { }).overrideAttrs (old: {
      passthru = (old.passthru or { }) // {
        checks = (old.passthru.checks or { }) // {
          both = pkgs.runCommand "crypto-tools-check-both" { passthru.ci.heavy = true; } ''
            test -e ${self.crypto-tools.checks.runtime}
            test -e ${self.crypto-tools-wasm64.checks.runtime}
            touch $out
          '';
        };
      };
    });
    crypto-tools-wasm64 = callPackage ./crypto-tools/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      libkcapi = self.libkcapi-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    packet-sockets-wasm64 = callPackage ./packet-sockets/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    virtual-network-wasm64 = self.virtual-network.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    autofs-runtime-wasm64 = self.autofs-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
      vm-test = vmTestWasm64;
    };
    vsock-runtime-wasm64 = self.vsock-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
      vm-test = vmTestWasm64;
    };
    ninep-wasm64 = self.ninep.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      linux = linuxNinep64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override { linux = linuxNinep64; };
      };
    };
    direct-io-wasm64 = callPackage ./direct-io/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    vm-events-wasm64 = callPackage ./vm-events/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      procps-vmstat = self.procps-vmstat-wasm64;
      vm-test = vmTestWasm64;
    };
    fuse-passthrough-wasm64 = callPackage ./fuse-passthrough/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-namespaces = callPackage ./clone-namespaces/package.nix { };
    clone-flags64 = callPackage ./clone-flags64/package.nix {
      extraChecks.both = pkgs.runCommand "clone-flags64-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-flags64.checks.runtime}
        test -e ${self.clone-flags64-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-empty-mount = callPackage ./clone-empty-mount/package.nix {
      extraChecks.both = pkgs.runCommand "clone-empty-mount-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-empty-mount.checks.runtime}
        test -e ${self.clone-empty-mount-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-empty-mount-wasm64 = callPackage ./clone-empty-mount/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    pidfd-getfd = callPackage ./pidfd-getfd/package.nix {
      extraChecks.both = pkgs.runCommand "pidfd-getfd-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.pidfd-getfd.checks.runtime}
        test -e ${self.pidfd-getfd-wasm64.checks.runtime}
        touch $out
      '';
    };
    pidfd-getfd-wasm64 = callPackage ./pidfd-getfd/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-untraced = callPackage ./clone-untraced/package.nix {
      extraChecks.return-work =
        pkgs.runCommand "fork-first-return-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.clone-untraced.checks.runtime}
            test -e ${self.clone-untraced-wasm64.checks.runtime}
            test -e ${self.fork-continuation.checks.runtime}
            test -e ${self.fork-continuation-wasm64.checks.runtime}
            test -e ${self.fork-continuation.checks.child-signals}
            test -e ${self.fork-continuation-wasm64.checks.child-signals}
            test -e ${self.fork-continuation.checks.resume-signals}
            test -e ${self.fork-continuation-wasm64.checks.resume-signals}
            touch $out
          '';
      extraChecks.both = pkgs.runCommand "clone-untraced-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-untraced.checks.runtime}
        test -e ${self.clone-untraced-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-untraced-wasm64 = callPackage ./clone-untraced/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };

    clone-parent = callPackage ./clone-parent/package.nix {
      extraChecks.both = pkgs.runCommand "clone-parent-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-parent.checks.runtime}
        test -e ${self.clone-parent-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-parent-wasm64 = callPackage ./clone-parent/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-lifecycle = callPackage ./clone-lifecycle/package.nix {
      extraChecks.both = pkgs.runCommand "clone-lifecycle-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-lifecycle.checks.runtime}
        test -e ${self.clone-lifecycle-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-lifecycle-wasm64 = callPackage ./clone-lifecycle/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-exit-signal = callPackage ./clone-exit-signal/package.nix {
      extraChecks.both = pkgs.runCommand "clone-exit-signal-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-exit-signal.checks.runtime}
        test -e ${self.clone-exit-signal-wasm64.checks.runtime}
        touch $out
      '';
    };
    clone-exit-signal-wasm64 = callPackage ./clone-exit-signal/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-timens = callPackage ./clone-timens/package.nix { };
    clone-pid-select = callPackage ./clone-pid-select/package.nix { };
    clone-sharing = callPackage ./clone-sharing/package.nix {
      extraChecks.both = pkgs.runCommand "clone-sharing-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.clone-sharing.checks.runtime}
        test -e ${self.clone-sharing-wasm64.checks.runtime}
        touch $out
      '';
    };
    timezone = callPackage ./timezone/package.nix { };
    file-mmap-stream = callPackage ./file-mmap-stream/package.nix {
      vm-test = self.vm-test.override {
        kernel = self.kernel.override {
          linux = self.linux.override { fileMmapStreamCandidate = true; };
        };
      };
    };
    file-mmap-inflight = callPackage ./file-mmap-inflight/package.nix {
      vm-test = self.vm-test.override {
        kernel = self.kernel.override {
          linux = self.linux.override { fileMmapStreamCandidate = true; };
        };
      };
    };
    file-mmap-inflight-wasm64 = callPackage ./file-mmap-inflight/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override { fileMmapStreamCandidate = true; };
        };
      };
    };
    file-mmap-stream-wasm64 = callPackage ./file-mmap-stream/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override { fileMmapStreamCandidate = true; };
        };
      };
    };
    timezone-wasm64 = callPackage ./timezone/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-timens-wasm64 = callPackage ./clone-timens/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-pid-select-wasm64 = callPackage ./clone-pid-select/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-sharing-wasm64 = callPackage ./clone-sharing/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-flags64-wasm64 = callPackage ./clone-flags64/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-namespaces-wasm64 = callPackage ./clone-namespaces/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
    };
    clone-arguments = callPackage ./clone-arguments/package.nix { };
    clone-arguments-wasm64 = callPackage ./clone-arguments/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    seccomp-strict = callPackage ./seccomp-strict/package.nix { };
    seccomp-strict-wasm64 = callPackage ./seccomp-strict/package.nix {
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    public-syscall-wasm64 = callPackage ./public-syscall/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    user-fault-group = callPackage ./user-fault-group/package.nix { };
    user-fault-group-wasm64 = callPackage ./user-fault-group/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    keyrings = callPackage ./keyrings/package.nix { };
    keyrings-wasm64 = callPackage ./keyrings/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    binfmt-misc = callPackage ./binfmt-misc/package.nix { };
    binfmt-misc-wasm64 = callPackage ./binfmt-misc/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    exec-security = callPackage ./exec-security/package.nix { };
    exec-security-wasm64 = callPackage ./exec-security/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      vm-test = vmTestWasm64;
    };
    fanotify = callPackage ./fanotify/package.nix { };
    fanotify-wasm64 = callPackage ./fanotify/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    ext4-quota = callPackage ./ext4-quota/package.nix { };
    ext4-quota-wasm64 = self.ext4-quota.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    vfat-volume = callPackage ./vfat-volume/package.nix { };
    vfat-volume-wasm64 = callPackage ./vfat-volume/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    exfat-volume = callPackage ./exfat-volume/package.nix { };
    exfat-volume-wasm64 = callPackage ./exfat-volume/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    isofs-volume = callPackage ./isofs-volume/package.nix { };
    isofs-volume-wasm64 = callPackage ./isofs-volume/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    udf-volume = callPackage ./udf-volume/package.nix { };
    udf-volume-wasm64 = callPackage ./udf-volume/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    ntfs-volume = callPackage ./ntfs-volume/package.nix { };
    ntfs-volume-wasm64 = callPackage ./ntfs-volume/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    erofs-metadata = callPackage ./erofs-metadata/package.nix { };
    erofs-metadata-wasm64 = callPackage ./erofs-metadata/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    squashfs-zstd = callPackage ./squashfs-zstd/package.nix { };
    squashfs-zstd-wasm64 = callPackage ./squashfs-zstd/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    squashfs-xz = callPackage ./squashfs-zstd/package.nix { compression = "xz"; };
    squashfs-xz-wasm64 = callPackage ./squashfs-zstd/package.nix {
      compression = "xz";
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    squashfs-xattrs = callPackage ./squashfs-zstd/package.nix { xattrs = true; };
    squashfs-xattrs-wasm64 = callPackage ./squashfs-zstd/package.nix {
      xattrs = true;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    initramfs-zstd = callPackage ./initramfs-zstd/package.nix { };
    initramfs-zstd-wasm64 = callPackage ./initramfs-zstd/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    initramfs-xz = callPackage ./initramfs-zstd/package.nix { compression = "xz"; };
    initramfs-xz-wasm64 = callPackage ./initramfs-zstd/package.nix {
      compression = "xz";
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    cpu-accounting = callPackage ./cpu-accounting/package.nix {
      vm-test = vtimeVm32;
      extraChecks = vtimeChecks vtimeVm32 self.toolchain-smoke self.fork-continuation;
    };
    cpu-accounting-wasm64 = callPackage ./cpu-accounting/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vtimeVm64;
      extraChecks = vtimeChecks vtimeVm64 self.toolchain-smoke-wasm64 self.fork-continuation-wasm64;
    };
    sdk-fork-continuation = callPackage ./fork-continuation/sdk.nix { };
    sdk-fork-automatic = self.sdk-fork-continuation.override { automaticFinalize = true; };
    sdk-fork-automatic-wasm64 = self.sdk-fork-continuation-wasm64.override {
      automaticFinalize = true;
    };
    sdk-fork-brk = self.sdk-fork-automatic.override { routedBrk = true; };
    sdk-fork-brk-wasm64 = self.sdk-fork-automatic-wasm64.override { routedBrk = true; };
    sdk-fork-cxx = self.sdk-fork-automatic.override { cxxExceptions = true; };
    sdk-fork-cxx-wasm64 = self.sdk-fork-automatic-wasm64.override { cxxExceptions = true; };
    sdk-fork-cooperative-poll = self.sdk-fork-continuation.override { cooperativePoll = true; };
    sdk-fork-cooperative-poll-wasm64 = self.sdk-fork-continuation-wasm64.override {
      cooperativePoll = true;
    };
    sdk-fork-cooperative-poll-libc = self.sdk-fork-continuation.override {
      cooperativePoll = true;
      libraryCoverage = true;
    };
    sdk-fork-cooperative-poll-libc-wasm64 = self.sdk-fork-continuation-wasm64.override {
      cooperativePoll = true;
      libraryCoverage = true;
    };
    sdk-fork-automatic-poll-libc = self.sdk-fork-cooperative-poll-libc.override {
      automaticFinalize = true;
    };
    sdk-fork-automatic-poll-libc-wasm64 = self.sdk-fork-cooperative-poll-libc-wasm64.override {
      automaticFinalize = true;
    };
    fork-poll = callPackage ./fork-poll/package.nix {
      extraChecks.both = pkgs.runCommand "fork-poll-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.fork-poll.checks.runtime}
        test -e ${self.fork-poll-wasm64.checks.runtime}
        touch $out
      '';
    };
    fork-poll-wasm64 = callPackage ./fork-poll/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-cooperative-poll = self.sdk-fork-cooperative-poll-wasm64;
      vm-test = vmTestWasm64;
    };
    fork-poll-libc = callPackage ./fork-poll/package.nix {
      libraryCoverage = true;
      sdk-fork-cooperative-poll = self.sdk-fork-cooperative-poll-libc;
      extraChecks.both = pkgs.runCommand "fork-poll-libc-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fork-poll-libc.checks.runtime}
        test -e ${self.fork-poll-libc-wasm64.checks.runtime}
        test -e ${self.fork-poll.checks.runtime}
        test -e ${self.fork-poll-wasm64.checks.runtime}
        touch $out
      '';
    };
    fork-poll-libc-wasm64 = callPackage ./fork-poll/package.nix {
      libraryCoverage = true;
      platform = self.platform-wasm64;
      sdk-fork-cooperative-poll = self.sdk-fork-cooperative-poll-libc-wasm64;
      vm-test = vmTestWasm64;
    };
    fork-poll-automatic-libc = callPackage ./fork-poll/package.nix {
      libraryCoverage = true;
      automaticFinalize = true;
      sdk-fork-cooperative-poll = self.sdk-fork-automatic-poll-libc;
      extraChecks.both =
        pkgs.runCommand "fork-poll-automatic-libc-check-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.fork-poll-automatic-libc.checks.runtime}
            test -e ${self.fork-poll-automatic-libc-wasm64.checks.runtime}
            test -e ${self.fork-poll-libc.checks.runtime}
            test -e ${self.fork-poll-libc-wasm64.checks.runtime}
            touch $out
          '';
    };
    fork-poll-automatic-libc-wasm64 = callPackage ./fork-poll/package.nix {
      libraryCoverage = true;
      automaticFinalize = true;
      platform = self.platform-wasm64;
      sdk-fork-cooperative-poll = self.sdk-fork-automatic-poll-libc-wasm64;
      vm-test = vmTestWasm64;
    };
    sdk-fork-continuation-wasm64 = callPackage ./fork-continuation/sdk.nix {
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      sysroot-base = self.sysroot-base-wasm64;
      sysroot = self.sysroot-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sdk = self.sdk-wasm64;
    };
    fork-continuation = callPackage ./fork-continuation/package.nix { };
    fork-high32 = callPackage ./fork-continuation/high32.nix { };
    fork-continuation-wasm64 = callPackage ./fork-continuation/package.nix {
      kernel = self.kernel-wasm64;
      platform = self.platform-wasm64;
      sysroot = self.sysroot-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
    };
    fork-automatic = callPackage ./fork-automatic/package.nix {
      extraChecks.both = pkgs.runCommand "fork-automatic-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fork-automatic.checks.runtime}
        test -e ${self.fork-automatic-wasm64.checks.runtime}
        test -e ${self.sdk-fork-automatic.checks.wrapper}
        test -e ${self.sdk-fork-automatic-wasm64.checks.wrapper}
        test -e ${self.findutils-fork.checks.runtime}
        test -e ${self.findutils-fork-wasm64.checks.runtime}
        touch $out
      '';
      extraChecks.tools =
        pkgs.runCommand "fork-automatic-tools-check-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.fork-automatic.checks.both}
            test -e ${self.dash-fork.checks.runtime}
            test -e ${self.dash-fork-wasm64.checks.runtime}
            test -e ${self.bash-fork.checks.sjlj}
            test -e ${self.bash-fork-wasm64.checks.sjlj}
            test -e ${self.bash-fork.checks.runtime}
            test -e ${self.bash-fork-wasm64.checks.runtime}
            test -e ${self.tar-fork.checks.runtime}
            test -e ${self.tar-fork-wasm64.checks.runtime}
            test -e ${self.git-fork.checks.runtime}
            test -e ${self.git-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    fork-automatic-wasm64 = callPackage ./fork-automatic/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      vm-test = vmTestWasm64;
    };
    fork-brk = callPackage ./fork-brk/package.nix {
      extraChecks.both = pkgs.runCommand "fork-brk-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.sdk-fork-brk.checks.wrapper}
        test -e ${self.sdk-fork-brk-wasm64.checks.wrapper}
        test -e ${self.fork-brk.checks.runtime}
        test -e ${self.fork-brk-wasm64.checks.runtime}
        test -e ${self.fork-brk.checks.allocator}
        test -e ${self.fork-brk-wasm64.checks.allocator}
        test -e ${self.fork-brk.checks.corpus}
        test -e ${self.fork-brk-wasm64.checks.corpus}
        touch $out
      '';
    };
    fork-brk-wasm64 = callPackage ./fork-brk/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-brk = self.sdk-fork-brk-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
    };
    fork-cxx = callPackage ./fork-cxx/package.nix {
      extraChecks.both = pkgs.runCommand "fork-cxx-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fork-cxx.checks.runtime}
        test -e ${self.fork-cxx-wasm64.checks.runtime}
        test -e ${self.sdk-fork-cxx.checks.wrapper}
        test -e ${self.sdk-fork-cxx-wasm64.checks.wrapper}
        test -e ${self.fork-automatic.checks.runtime}
        test -e ${self.fork-automatic-wasm64.checks.runtime}
        touch $out
      '';
    };
    fork-cxx-wasm64 = callPackage ./fork-cxx/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-cxx = self.sdk-fork-cxx-wasm64;
      vm-test = vmTestWasm64;
    };
    dash-fork = callPackage ./dash-fork/package.nix { };
    bash-fork = callPackage ./bash-fork/package.nix { };
    bash-fork-wasm64 = callPackage ./bash-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    dash-fork-wasm64 = callPackage ./dash-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    vfork-runtime = callPackage ./vfork-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "vfork-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-fork-continuation.checks.wrapper}
            test -e ${self.sdk-fork-continuation-wasm64.checks.wrapper}
            test -e ${self.vfork-runtime.checks.runtime}
            test -e ${self.vfork-runtime-wasm64.checks.runtime}
            test -e ${self.dash-fork.checks.runtime}
            test -e ${self.dash-fork-wasm64.checks.runtime}
            test -e ${self.fork-continuation.checks.runtime}
            test -e ${self.fork-continuation-wasm64.checks.runtime}
            touch $out
          '';
    };
    vfork-runtime-wasm64 = callPackage ./vfork-runtime/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };

    # The wasm stdenv: nixpkgs' generic stdenv with a cc-wrapped fork toolchain
    # and wasm32-unknown-linux-musl as the host platform. Everything below here
    # is an ordinary nixpkgs-style package.
    stdenv = if debug then self.stdenvDebug else self.stdenvRelease;
    # Imported rather than callPackaged: callPackage's makeOverridable would
    # shadow the stdenv's own `.override`, which the debug adapter needs.
    stdenvRelease = import ./stdenv.nix {
      inherit pkgs;
      inherit (self) platform llvm-toolchain sysroot;
    };
    stdenvDebug = pkgs.stdenvAdapters.keepDebugInfo self.stdenvRelease;
    # Opt-in native userland; never inherit wasm32 headers, libc or loader
    # images merely because the surrounding default scope is wasm32.
    stdenv-wasm64 =
      if debug then pkgs.stdenvAdapters.keepDebugInfo stdenvReleaseWasm64 else stdenvReleaseWasm64;
    stdenv-fork-automatic = import ./stdenv.nix {
      inherit pkgs;
      inherit (self) llvm-toolchain;
      sysroot = self.sdk-fork-automatic.sysroot;
      configSite = self.sdk-fork-automatic.configSite;
      platform = self.platform // {
        compilerFlags = self.sdk-fork-automatic.compilerFlags;
      };
    };
    stdenv-fork-automatic-wasm64 = import ./stdenv.nix {
      inherit pkgs;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sdk-fork-automatic-wasm64.sysroot;
      configSite = self.sdk-fork-automatic-wasm64.configSite;
      platform = self.platform-wasm64 // {
        compilerFlags = self.sdk-fork-automatic-wasm64.compilerFlags;
      };
    };
    stdenv-dynamic-loader = import ./stdenv.nix {
      inherit pkgs;
      llvm-toolchain = self.sdk-dynamic-loader.compiler;
      sysroot = self.sdk-dynamic-loader.sysroot;
      configSite = self.sdk-dynamic-loader.configSite;
      platform = self.platform // {
        linkerFlags = self.platform.linkerFlags ++ [
          "--growable-table"
          "--export-all"
        ];
      };
    };
    stdenv-dynamic-loader-wasm64 = import ./stdenv.nix {
      inherit pkgs;
      llvm-toolchain = self.sdk-dynamic-loader-wasm64.compiler;
      sysroot = self.sdk-dynamic-loader-wasm64.sysroot;
      configSite = self.sdk-dynamic-loader-wasm64.configSite;
      platform = self.platform-wasm64 // {
        linkerFlags = self.platform-wasm64.linkerFlags ++ [
          "--growable-table"
          "--export-all"
        ];
      };
    };
    apk-wasm64 = callPackage ./apk {
      tools = self.apk-tools-host;
      callPackage = lib.callPackageWith (
        { inherit lib pkgs; } // self // { platform = self.platform-wasm64; }
      );
    };
    image-wasm64 = callPackage ./image {
      callPackage = lib.callPackageWith (
        { inherit lib pkgs; } // self // { busybox = self.busybox-wasm64; }
      );
    };

    # A pinned nightly rustc with a from-source std for the wasm target.
    rust-toolchain = callPackage ./rust-toolchain/package.nix { };

    # userland:
    apk-tools = callPackage ./apk-tools/package.nix {
      src = self.apk-tools-src;
    };
    bash = callPackage ./bash/package.nix { };
    basic-init = callPackage ./basic-init/package.nix { };
    cpio-metadata = callPackage ./cpio-metadata/package.nix { };
    cpio-metadata-wasm64 = self.cpio-metadata.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      kernel = self.kernel-wasm64;
      vm-test = vmTestWasm64;
    };
    mmap-benchmark =
      let
        fileKernel = self.kernel.override {
          linux = self.linux.override {
            fileMmapCandidate = true;
            fileMmapStreamCandidate = false;
          };
        };
      in
      callPackage ./mmap-benchmark/package.nix {
        inherit fileKernel;
        vm-test-closed = vmTestClosed32;
        vm-test-file = self.vm-test.override {
          kernel = fileKernel;
        };
        vm-test-copy = self.vm-test.override {
          kernel = self.kernel.override {
            linux = self.linux.override {
              mmapCopyTest = true;
              fileMmapStreamCandidate = false;
            };
          };
        };
      };
    mmap-benchmark-wasm64 =
      let
        fileKernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override {
            fileMmapCandidate = true;
            fileMmapStreamCandidate = false;
          };
        };
      in
      callPackage ./mmap-benchmark/package.nix {
        inherit fileKernel;
        vm-test-closed = vmTestClosed64;
        vm-test-file = vmTestWasm64.override {
          kernel = fileKernel;
        };
        platform = self.platform-wasm64;
        llvm-toolchain = self.llvm-toolchain-wasm64;
        sysroot = self.sysroot-wasm64;
        vm-test = vmTestWasm64;
        sdk = self.sdk-wasm64;
        vm-test-copy = vmTestWasm64.override {
          kernel = self.kernel-wasm64.override {
            linux = self.linux-wasm64.override {
              mmapCopyTest = true;
              fileMmapStreamCandidate = false;
            };
          };
        };
      };
    busybox = callPackage ./busybox/package.nix {
      extraChecks.shell-status-both =
        pkgs.runCommand "busybox-shell-status-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.busybox.checks.shell-status}
            test -e ${self.busybox-wasm64.checks.shell-status}
            test -e ${self.busybox.checks.hush-nounset}
            test -e ${self.busybox-wasm64.checks.hush-nounset}
            test -e ${self.busybox.checks.processes}
            test -e ${self.busybox-wasm64.checks.processes}
            test -e ${self.busybox.checks.source-bundle-host}
            test -e ${self.busybox.checks.source-bundle}
            test -e ${self.busybox-wasm64.checks.source-bundle}
            touch $out
          '';
    };
    busybox-wasm64 = self.busybox.override {
      extraChecks = { };
      stdenv = self.stdenv-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
      vm-test = vmTestWasm64;
    };
    busybox-fork = callPackage ./busybox-fork/package.nix {
      extraChecks.both =
        pkgs.runCommand "busybox-fork-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-fork-continuation.checks.wrapper}
            test -e ${self.sdk-fork-continuation-wasm64.checks.wrapper}
            test -e ${self.busybox-fork.checks.runtime}
            test -e ${self.busybox-fork-wasm64.checks.runtime}
            test -e ${self.fork-continuation.checks.runtime}
            test -e ${self.fork-continuation-wasm64.checks.runtime}
            touch $out
          '';
    };
    busybox-fork-wasm64 = callPackage ./busybox-fork/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    bzip2 = callPackage ./bzip2/package.nix { };
    bzip2-wasm64 = self.bzip2.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    ca-certificates = callPackage ./ca-certificates/package.nix { };
    coreutils = callPackage ./coreutils/package.nix { };
    coreutils-sort-fork = callPackage ./coreutils-sort-fork/package.nix {
      extraChecks.both =
        pkgs.runCommand "coreutils-sort-fork-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.coreutils-sort-fork.checks.runtime}
            test -e ${self.coreutils-sort-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    coreutils-sort-fork-wasm64 = callPackage ./coreutils-sort-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    coreutils-split-fork = callPackage ./coreutils-split-fork/package.nix {
      extraChecks.both =
        pkgs.runCommand "coreutils-split-fork-both-widths" { passthru.ci.heavy = true; }
          ''
            test -e ${self.coreutils-split-fork.checks.runtime}
            test -e ${self.coreutils-split-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    coreutils-split-fork-wasm64 = callPackage ./coreutils-split-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    coreutils-timeout-fork = callPackage ./coreutils-timeout-fork/package.nix {
      extraChecks.both =
        pkgs.runCommand "coreutils-timeout-fork-check-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.fork-poll-automatic-libc.checks.both}
            test -e ${self.coreutils-timeout-fork.checks.runtime}
            test -e ${self.coreutils-timeout-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    coreutils-timeout-fork-wasm64 = self.coreutils-timeout-fork.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    curl = callPackage ./curl/package.nix { };
    curl-wasm64 = self.curl.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      openssl = self.openssl-wasm64;
      zlib = self.zlib-wasm64;
      sdk = self.sdk-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    diffutils = callPackage ./diffutils/package.nix { };
    dropbear = callPackage ./dropbear/package.nix { };
    e2fsprogs = callPackage ./e2fsprogs/package.nix { };
    file = callPackage ./file/package.nix { };
    file-wasm64 = self.file.override {
      stdenv = self.stdenv-wasm64;
      zlib = self.zlib-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    findutils = callPackage ./findutils/package.nix { };
    findutils-fork = callPackage ./findutils-fork/package.nix {
      inherit (self) sdk-fork-automatic;
      extraChecks.both = pkgs.runCommand "findutils-standard-fork-both" { passthru.ci.heavy = true; } ''
        test -e ${self.findutils-fork.checks.runtime}
        test -e ${self.findutils-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    findutils-fork-wasm64 = callPackage ./findutils-fork/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    gawk = callPackage ./gawk/package.nix { };
    gawk-dynamic = callPackage ./gawk-dynamic/package.nix {
      extraChecks.both =
        pkgs.runCommand "gawk-dynamic-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.gawk-dynamic.checks.runtime}
            test -e ${self.gawk-dynamic-wasm64.checks.runtime}
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            touch $out
          '';
    };
    gawk-dynamic-wasm64 = callPackage ./gawk-dynamic/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    git = callPackage ./git/package.nix { };
    git-fork = callPackage ./git-fork/package.nix {
      extraChecks.both = pkgs.runCommand "git-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.git-fork.checks.runtime}
        test -e ${self.git-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    git-fork-wasm64 = callPackage ./git-fork/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      zlib = self.zlib-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    git-wasm64 = self.git.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      busybox = self.busybox-wasm64;
      zlib = self.zlib-wasm64;
      curl = self.curl-wasm64;
      openssl = self.openssl-wasm64;
      vm-test = vmTestWasm64;
    };
    gawk-fork = callPackage ./gawk-fork/package.nix {
      extraChecks.both = pkgs.runCommand "gawk-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.gawk-fork.checks.runtime}
        test -e ${self.gawk-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    gawk-fork-wasm64 = self.gawk-fork.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    acl-runtime = callPackage ./acl-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "acl-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.acl-runtime.checks.runtime}
        test -e ${self.acl-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    acl-runtime-wasm64 = self.acl-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    gdbm-runtime = callPackage ./gdbm-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "gdbm-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.gdbm-runtime.checks.runtime}
        test -e ${self.gdbm-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    gdbm-runtime-wasm64 = self.gdbm-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    grep = callPackage ./grep/package.nix { };
    libffi-runtime = callPackage ./libffi-runtime/package.nix { };
    libffi-runtime-wasm64 = self.libffi-runtime.override {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    libffi-runtime-linux64-abi-wasm64 = self.libffi-runtime.override {
      linux64Abi = true;
      platform = self.linux64-abi-wasm64.wordPlatform;
      sdk-dynamic-loader = self.linux64-abi-dynamic-wasm64.sdk;
      llvm-toolchain = self.linux64-abi-wasm64.dependencies.toolchainWord;
      # BusyBox launches the test as a separate executable.
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    mincore-nommu = callPackage ./mincore-nommu/package.nix { };
    mincore-nommu-wasm64 = self.mincore-nommu.override {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    task-io-accounting = callPackage ./task-io-accounting/package.nix { };
    task-io-accounting-wasm64 = self.task-io-accounting.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    psi-runtime = callPackage ./psi-runtime/package.nix { };
    psi-runtime-wasm64 = self.psi-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    pcre2 = callPackage ./pcre2/package.nix { };
    pcre2-wasm64 = self.pcre2.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
    };
    grep-pcre2 = callPackage ./grep-pcre2/package.nix {
      extraChecks.both = pkgs.runCommand "grep-pcre2-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.grep-pcre2.checks.pcre-runtime}
        test -e ${self.grep-pcre2-wasm64.checks.pcre-runtime}
        touch $out
      '';
    };
    grep-pcre2-wasm64 = self.grep-pcre2.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      pcre2 = self.pcre2-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    jq = callPackage ./jq/package.nix { };
    less = callPackage ./less/package.nix { };
    lua = callPackage ./lua/package.nix { };
    lua-wasm64 = self.lua.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    lua-dynamic = callPackage ./lua-dynamic/package.nix { };
    lua-dynamic-wasm64 = callPackage ./lua-dynamic/package.nix {
      platform = self.platform-wasm64;
      lua = self.lua-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
    };
    lua-extension-runtime = callPackage ./lua-extension-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "lua-extension-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            test -e ${self.lua-extension-runtime.checks.runtime}
            test -e ${self.lua-extension-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    lua-extension-runtime-wasm64 = callPackage ./lua-extension-runtime/package.nix {
      platform = self.platform-wasm64;
      lua-dynamic = self.lua-dynamic-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    make = callPackage ./make/package.nix { };
    make-dynamic = callPackage ./make-dynamic/package.nix {
      extraChecks.both =
        pkgs.runCommand "make-dynamic-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.make-dynamic.checks.runtime}
            test -e ${self.make-dynamic-wasm64.checks.runtime}
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            touch $out
          '';
    };
    make-dynamic-wasm64 = callPackage ./make-dynamic/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    ncurses = callPackage ./ncurses/package.nix { };
    ncurses-wasm64 = self.ncurses.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    libevent-runtime = callPackage ./libevent-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "libevent-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.libevent-runtime.checks.runtime}
        test -e ${self.libevent-runtime-wasm64.checks.runtime}
        test -e ${self.libevent-runtime.checks.tls-runtime}
        test -e ${self.libevent-runtime-wasm64.checks.tls-runtime}
        touch $out
      '';
    };
    libevent-runtime-wasm64 = self.libevent-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      openssl = self.openssl-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    libssh-runtime = callPackage ./libssh-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "libssh-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.libssh-runtime.checks.runtime}
        test -e ${self.libssh-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    libssh-runtime-wasm64 = self.libssh-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      openssl = self.openssl-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    aio-runtime = callPackage ./aio-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "aio-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.aio-runtime.checks.runtime}
        test -e ${self.aio-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    aio-runtime-wasm64 = self.aio-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    io-uring-runtime = callPackage ./io-uring-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "io-uring-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.io-uring-runtime.checks.runtime}
        test -e ${self.io-uring-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    io-uring-runtime-wasm64 = self.io-uring-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    coredump-runtime = callPackage ./coredump-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "coredump-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.coredump-runtime.checks.runtime}
        test -e ${self.coredump-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    coredump-runtime-wasm64 = self.coredump-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    input-runtime = callPackage ./input-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "input-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.input-runtime.checks.runtime}
        test -e ${self.input-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    input-runtime-wasm64 = self.input-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fb-runtime = callPackage ./fb-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "fb-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fb-runtime.checks.runtime}
        test -e ${self.fb-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    fb-runtime-wasm64 = self.fb-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    splice-pty-runtime = callPackage ./splice-pty-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "splice-pty-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.splice-pty-runtime.checks.runtime}
        test -e ${self.splice-pty-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    splice-pty-runtime-wasm64 = self.splice-pty-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fanotify-runtime = callPackage ./fanotify-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "fanotify-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fanotify-runtime.checks.runtime}
        test -e ${self.fanotify-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    fanotify-runtime-wasm64 = self.fanotify-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    rtnetlink-runtime = callPackage ./rtnetlink-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "rtnetlink-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.rtnetlink-runtime.checks.runtime}
        test -e ${self.rtnetlink-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    rtnetlink-runtime-wasm64 = self.rtnetlink-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    overlay-runtime = callPackage ./overlay-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "overlay-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.overlay-runtime.checks.runtime}
        test -e ${self.overlay-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    overlay-runtime-wasm64 = self.overlay-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fsverity-runtime = callPackage ./fsverity-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "fsverity-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fsverity-runtime.checks.runtime}
        test -e ${self.fsverity-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    fsverity-runtime-wasm64 = self.fsverity-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fiemap-sparse-runtime = callPackage ./fiemap-sparse-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "fiemap-sparse-runtime-check-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.fiemap-sparse-runtime.checks.runtime}
            test -e ${self.fiemap-sparse-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    fiemap-sparse-runtime-wasm64 = self.fiemap-sparse-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    sockdiag-runtime = callPackage ./sockdiag-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "sockdiag-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.sockdiag-runtime.checks.runtime}
        test -e ${self.sockdiag-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    sockdiag-runtime-wasm64 = self.sockdiag-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fhandle-runtime = callPackage ./fhandle-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "fhandle-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fhandle-runtime.checks.runtime}
        test -e ${self.fhandle-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    fhandle-runtime-wasm64 = self.fhandle-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    taskstats-runtime = callPackage ./taskstats-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "taskstats-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.taskstats-runtime.checks.runtime}
            test -e ${self.taskstats-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    taskstats-runtime-wasm64 = self.taskstats-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fuse-runtime = callPackage ./fuse-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "fuse-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.fuse-runtime.checks.runtime}
            test -e ${self.fuse-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    fuse-runtime-wasm64 = self.fuse-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    af-alg-runtime = callPackage ./af-alg-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "af-alg-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.af-alg-runtime.checks.runtime}
            test -e ${self.af-alg-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    af-alg-runtime-wasm64 = self.af-alg-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    cgroup-v2-runtime = callPackage ./cgroup-v2-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "cgroup-v2-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.cgroup-v2-runtime.checks.runtime}
            test -e ${self.cgroup-v2-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    cgroup-v2-runtime-wasm64 = self.cgroup-v2-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    packet-socket-runtime = callPackage ./packet-socket-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "packet-socket-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.packet-socket-runtime.checks.runtime}
            test -e ${self.packet-socket-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    packet-socket-runtime-wasm64 = self.packet-socket-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    quotactl-runtime = callPackage ./quotactl-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "quotactl-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.quotactl-runtime.checks.runtime}
            test -e ${self.quotactl-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    quotactl-runtime-wasm64 = self.quotactl-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    squashfs-runtime = callPackage ./squashfs-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "squashfs-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.squashfs-runtime.checks.runtime}
            test -e ${self.squashfs-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    squashfs-runtime-wasm64 = self.squashfs-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    erofs-runtime = callPackage ./erofs-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "erofs-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.erofs-runtime.checks.runtime}
            test -e ${self.erofs-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    erofs-runtime-wasm64 = self.erofs-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    vfat-runtime = callPackage ./vfat-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "vfat-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.vfat-runtime.checks.runtime}
            test -e ${self.vfat-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    vfat-runtime-wasm64 = self.vfat-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    isofs-runtime = callPackage ./isofs-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "isofs-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.isofs-runtime.checks.runtime}
            test -e ${self.isofs-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    isofs-runtime-wasm64 = self.isofs-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    exfat-runtime = callPackage ./exfat-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "exfat-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.exfat-runtime.checks.runtime}
            test -e ${self.exfat-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    exfat-runtime-wasm64 = self.exfat-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    udf-runtime = callPackage ./udf-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "udf-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.udf-runtime.checks.runtime}
            test -e ${self.udf-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    udf-runtime-wasm64 = self.udf-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    landlock-runtime = callPackage ./landlock-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "landlock-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.landlock-runtime.checks.runtime}
            test -e ${self.landlock-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    landlock-runtime-wasm64 = self.landlock-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    tun-tap-runtime = callPackage ./tun-tap-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "tun-tap-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.tun-tap-runtime.checks.runtime}
            test -e ${self.tun-tap-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    tun-tap-runtime-wasm64 = self.tun-tap-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    loop-device-runtime = callPackage ./loop-device-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "loop-device-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.loop-device-runtime.checks.runtime}
            test -e ${self.loop-device-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    loop-device-runtime-wasm64 = self.loop-device-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    veth-netns-runtime = callPackage ./veth-netns-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "veth-netns-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.veth-netns-runtime.checks.runtime}
            test -e ${self.veth-netns-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    veth-netns-runtime-wasm64 = self.veth-netns-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    dummy-policy-route-runtime = callPackage ./dummy-policy-route-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "dummy-policy-route-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.dummy-policy-route-runtime.checks.runtime}
            test -e ${self.dummy-policy-route-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    dummy-policy-route-runtime-wasm64 = self.dummy-policy-route-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    posix-acl-runtime = callPackage ./posix-acl-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "posix-acl-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.posix-acl-runtime.checks.runtime}
            test -e ${self.posix-acl-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    posix-acl-runtime-wasm64 = self.posix-acl-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    cross-memory-attach-runtime = callPackage ./cross-memory-attach-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "cross-memory-attach-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.cross-memory-attach-runtime.checks.runtime}
            test -e ${self.cross-memory-attach-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    cross-memory-attach-runtime-wasm64 = self.cross-memory-attach-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    dnotify-runtime = callPackage ./dnotify-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "dnotify-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.dnotify-runtime.checks.runtime}
            test -e ${self.dnotify-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    dnotify-runtime-wasm64 = self.dnotify-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    membarrier-runtime = callPackage ./membarrier-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "membarrier-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.membarrier-runtime.checks.runtime}
            test -e ${self.membarrier-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    membarrier-runtime-wasm64 = self.membarrier-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    time-ns-runtime = callPackage ./time-ns-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "time-ns-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.time-ns-runtime.checks.runtime}
            test -e ${self.time-ns-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    time-ns-runtime-wasm64 = self.time-ns-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    uts-ipc-ns-runtime = callPackage ./uts-ipc-ns-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "uts-ipc-ns-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.uts-ipc-ns-runtime.checks.runtime}
            test -e ${self.uts-ipc-ns-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    uts-ipc-ns-runtime-wasm64 = self.uts-ipc-ns-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    ipv6-policy-route-runtime = callPackage ./ipv6-policy-route-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "ipv6-policy-route-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.ipv6-policy-route-runtime.checks.runtime}
            test -e ${self.ipv6-policy-route-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    ipv6-policy-route-runtime-wasm64 = self.ipv6-policy-route-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    bpf-syscall-runtime = callPackage ./bpf-syscall-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "bpf-syscall-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.bpf-syscall-runtime.checks.runtime}
            test -e ${self.bpf-syscall-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    bpf-syscall-runtime-wasm64 = self.bpf-syscall-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    ip-multipath-runtime = callPackage ./ip-multipath-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "ip-multipath-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.ip-multipath-runtime.checks.runtime}
            test -e ${self.ip-multipath-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    ip-multipath-runtime-wasm64 = self.ip-multipath-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    ext2-runtime = callPackage ./ext2-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "ext2-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.ext2-runtime.checks.runtime}
            test -e ${self.ext2-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    ext2-runtime-wasm64 = self.ext2-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    ip-multicast-runtime = callPackage ./ip-multicast-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "ip-multicast-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.ip-multicast-runtime.checks.runtime}
            test -e ${self.ip-multicast-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    ip-multicast-runtime-wasm64 = self.ip-multicast-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    timerfd-signalfd-runtime = callPackage ./timerfd-signalfd-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "timerfd-signalfd-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.timerfd-signalfd-runtime.checks.runtime}
            test -e ${self.timerfd-signalfd-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    timerfd-signalfd-runtime-wasm64 = self.timerfd-signalfd-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    statx-copy-file-range-runtime = callPackage ./statx-copy-file-range-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "statx-copy-file-range-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.statx-copy-file-range-runtime.checks.runtime}
            test -e ${self.statx-copy-file-range-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    statx-copy-file-range-runtime-wasm64 = self.statx-copy-file-range-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    socket-unix-seqpacket-runtime = callPackage ./socket-unix-seqpacket-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "socket-unix-seqpacket-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.socket-unix-seqpacket-runtime.checks.runtime}
            test -e ${self.socket-unix-seqpacket-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    socket-unix-seqpacket-runtime-wasm64 = self.socket-unix-seqpacket-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    posix-timer-runtime = callPackage ./posix-timer-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "posix-timer-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.posix-timer-runtime.checks.runtime}
            test -e ${self.posix-timer-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    posix-timer-runtime-wasm64 = self.posix-timer-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    futex-pi-runtime = callPackage ./futex-pi-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "futex-pi-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.futex-pi-runtime.checks.runtime}
            test -e ${self.futex-pi-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    futex-pi-runtime-wasm64 = self.futex-pi-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    pidfd-getfd-runtime = callPackage ./pidfd-getfd-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "pidfd-getfd-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.pidfd-getfd-runtime.checks.runtime}
            test -e ${self.pidfd-getfd-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    pidfd-getfd-runtime-wasm64 = self.pidfd-getfd-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    netlink-route-attr-runtime = callPackage ./netlink-route-attr-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "netlink-route-attr-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.netlink-route-attr-runtime.checks.runtime}
            test -e ${self.netlink-route-attr-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    netlink-route-attr-runtime-wasm64 = self.netlink-route-attr-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    rlimit-prlimit-runtime = callPackage ./rlimit-prlimit-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "rlimit-prlimit-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.rlimit-prlimit-runtime.checks.runtime}
            test -e ${self.rlimit-prlimit-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    rlimit-prlimit-runtime-wasm64 = self.rlimit-prlimit-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    binfmt-misc-runtime = callPackage ./binfmt-misc-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "binfmt-misc-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.binfmt-misc-runtime.checks.runtime}
            test -e ${self.binfmt-misc-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    binfmt-misc-runtime-wasm64 = self.binfmt-misc-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    seccomp-strict-runtime = callPackage ./seccomp-strict-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "seccomp-strict-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.seccomp-strict-runtime.checks.runtime}
            test -e ${self.seccomp-strict-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    seccomp-strict-runtime-wasm64 = self.seccomp-strict-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    netlink-crypto-runtime = callPackage ./netlink-crypto-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "netlink-crypto-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.netlink-crypto-runtime.checks.runtime}
            test -e ${self.netlink-crypto-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    netlink-crypto-runtime-wasm64 = self.netlink-crypto-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    kcmp-runtime = callPackage ./kcmp-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "kcmp-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.kcmp-runtime.checks.runtime}
            test -e ${self.kcmp-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    kcmp-runtime-wasm64 = self.kcmp-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    eventfd-semaphore-runtime = callPackage ./eventfd-semaphore-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "eventfd-semaphore-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.eventfd-semaphore-runtime.checks.runtime}
            test -e ${self.eventfd-semaphore-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    eventfd-semaphore-runtime-wasm64 = self.eventfd-semaphore-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    watch-queue-runtime = callPackage ./watch-queue-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "watch-queue-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.watch-queue-runtime.checks.runtime}
            test -e ${self.watch-queue-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    watch-queue-runtime-wasm64 = self.watch-queue-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    pipe2-splice-tee-runtime = callPackage ./pipe2-splice-tee-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "pipe2-splice-tee-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.pipe2-splice-tee-runtime.checks.runtime}
            test -e ${self.pipe2-splice-tee-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    pipe2-splice-tee-runtime-wasm64 = self.pipe2-splice-tee-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fcntl-ofd-lease-runtime = callPackage ./fcntl-ofd-lease-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "fcntl-ofd-lease-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.fcntl-ofd-lease-runtime.checks.runtime}
            test -e ${self.fcntl-ofd-lease-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    fcntl-ofd-lease-runtime-wasm64 = self.fcntl-ofd-lease-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    epoll-edge-oneshot-runtime = callPackage ./epoll-edge-oneshot-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "epoll-edge-oneshot-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.epoll-edge-oneshot-runtime.checks.runtime}
            test -e ${self.epoll-edge-oneshot-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    epoll-edge-oneshot-runtime-wasm64 = self.epoll-edge-oneshot-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    preadv2-pwritev2-fallocate-runtime = callPackage ./preadv2-pwritev2-fallocate-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "preadv2-pwritev2-fallocate-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.preadv2-pwritev2-fallocate-runtime.checks.runtime}
            test -e ${self.preadv2-pwritev2-fallocate-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    preadv2-pwritev2-fallocate-runtime-wasm64 = self.preadv2-pwritev2-fallocate-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    xattr-ext4-runtime = callPackage ./xattr-ext4-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "xattr-ext4-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.xattr-ext4-runtime.checks.runtime}
            test -e ${self.xattr-ext4-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    xattr-ext4-runtime-wasm64 = self.xattr-ext4-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    statvfs-utimensat-renameat2-runtime =
      callPackage ./statvfs-utimensat-renameat2-runtime/package.nix
        {
          extraChecks.both =
            pkgs.runCommand "statvfs-utimensat-renameat2-runtime-check-both"
              {
                passthru.ci.heavy = true;
              }
              ''
                test -e ${self.statvfs-utimensat-renameat2-runtime.checks.runtime}
                test -e ${self.statvfs-utimensat-renameat2-runtime-wasm64.checks.runtime}
                touch $out
              '';
        };
    statvfs-utimensat-renameat2-runtime-wasm64 = self.statvfs-utimensat-renameat2-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    prctl-caps-creds-runtime = callPackage ./prctl-caps-creds-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "prctl-caps-creds-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.prctl-caps-creds-runtime.checks.runtime}
            test -e ${self.prctl-caps-creds-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    prctl-caps-creds-runtime-wasm64 = self.prctl-caps-creds-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    getrusage-times-sysinfo-runtime = callPackage ./getrusage-times-sysinfo-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "getrusage-times-sysinfo-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.getrusage-times-sysinfo-runtime.checks.runtime}
            test -e ${self.getrusage-times-sysinfo-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    getrusage-times-sysinfo-runtime-wasm64 = self.getrusage-times-sysinfo-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    dup-pipe-nonblock-fionread-runtime = callPackage ./dup-pipe-nonblock-fionread-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "dup-pipe-nonblock-fionread-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.dup-pipe-nonblock-fionread-runtime.checks.runtime}
            test -e ${self.dup-pipe-nonblock-fionread-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    dup-pipe-nonblock-fionread-runtime-wasm64 = self.dup-pipe-nonblock-fionread-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    select-pselect-poll-ppoll-runtime = callPackage ./select-pselect-poll-ppoll-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "select-pselect-poll-ppoll-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.select-pselect-poll-ppoll-runtime.checks.runtime}
            test -e ${self.select-pselect-poll-ppoll-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    select-pselect-poll-ppoll-runtime-wasm64 = self.select-pselect-poll-ppoll-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    flock-fcntl-lock-runtime = callPackage ./flock-fcntl-lock-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "flock-fcntl-lock-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.flock-fcntl-lock-runtime.checks.runtime}
            test -e ${self.flock-fcntl-lock-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    flock-fcntl-lock-runtime-wasm64 = self.flock-fcntl-lock-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    socketpair-shutdown-ancillary-runtime =
      callPackage ./socketpair-shutdown-ancillary-runtime/package.nix
        {
          extraChecks.both =
            pkgs.runCommand "socketpair-shutdown-ancillary-runtime-check-both"
              {
                passthru.ci.heavy = true;
              }
              ''
                test -e ${self.socketpair-shutdown-ancillary-runtime.checks.runtime}
                test -e ${self.socketpair-shutdown-ancillary-runtime-wasm64.checks.runtime}
                touch $out
              '';
        };
    socketpair-shutdown-ancillary-runtime-wasm64 = self.socketpair-shutdown-ancillary-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    sparse-lseek-hole-runtime = callPackage ./sparse-lseek-hole-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "sparse-lseek-hole-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sparse-lseek-hole-runtime.checks.runtime}
            test -e ${self.sparse-lseek-hole-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    sparse-lseek-hole-runtime-wasm64 = self.sparse-lseek-hole-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    faccessat2-umask-chmod-utime-runtime =
      callPackage ./faccessat2-umask-chmod-utime-runtime/package.nix
        {
          extraChecks.both =
            pkgs.runCommand "faccessat2-umask-chmod-utime-runtime-check-both"
              {
                passthru.ci.heavy = true;
              }
              ''
                test -e ${self.faccessat2-umask-chmod-utime-runtime.checks.runtime}
                test -e ${self.faccessat2-umask-chmod-utime-runtime-wasm64.checks.runtime}
                touch $out
              '';
        };
    faccessat2-umask-chmod-utime-runtime-wasm64 = self.faccessat2-umask-chmod-utime-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    signal-sigaltstack-sigaction-runtime =
      callPackage ./signal-sigaltstack-sigaction-runtime/package.nix
        {
          extraChecks.both =
            pkgs.runCommand "signal-sigaltstack-sigaction-runtime-check-both"
              {
                passthru.ci.heavy = true;
              }
              ''
                test -e ${self.signal-sigaltstack-sigaction-runtime.checks.runtime}
                test -e ${self.signal-sigaltstack-sigaction-runtime-wasm64.checks.runtime}
                touch $out
              '';
        };
    signal-sigaltstack-sigaction-runtime-wasm64 = self.signal-sigaltstack-sigaction-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    ioctl-pty-termios-winsize-runtime = callPackage ./ioctl-pty-termios-winsize-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "ioctl-pty-termios-winsize-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.ioctl-pty-termios-winsize-runtime.checks.runtime}
            test -e ${self.ioctl-pty-termios-winsize-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    ioctl-pty-termios-winsize-runtime-wasm64 = self.ioctl-pty-termios-winsize-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    getrandom-urandom-prng-runtime = callPackage ./getrandom-urandom-prng-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "getrandom-urandom-prng-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.getrandom-urandom-prng-runtime.checks.runtime}
            test -e ${self.getrandom-urandom-prng-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    getrandom-urandom-prng-runtime-wasm64 = self.getrandom-urandom-prng-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    statfs-fstatfs-statvfs-runtime = callPackage ./statfs-fstatfs-statvfs-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "statfs-fstatfs-statvfs-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.statfs-fstatfs-statvfs-runtime.checks.runtime}
            test -e ${self.statfs-fstatfs-statvfs-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    statfs-fstatfs-statvfs-runtime-wasm64 = self.statfs-fstatfs-statvfs-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    sched-affinity-priority-runtime = callPackage ./sched-affinity-priority-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "sched-affinity-priority-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sched-affinity-priority-runtime.checks.runtime}
            test -e ${self.sched-affinity-priority-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    sched-affinity-priority-runtime-wasm64 = self.sched-affinity-priority-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    clock-nanosleep-itimer-runtime = callPackage ./clock-nanosleep-itimer-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "clock-nanosleep-itimer-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.clock-nanosleep-itimer-runtime.checks.runtime}
            test -e ${self.clock-nanosleep-itimer-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    clock-nanosleep-itimer-runtime-wasm64 = self.clock-nanosleep-itimer-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    close-range-runtime = callPackage ./close-range-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "close-range-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.close-range-runtime.checks.runtime}
            test -e ${self.close-range-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    close-range-runtime-wasm64 = self.close-range-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    chroot-runtime = callPackage ./chroot-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "chroot-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.chroot-runtime.checks.runtime}
            test -e ${self.chroot-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    chroot-runtime-wasm64 = self.chroot-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    posix-fadvise-sync-runtime = callPackage ./posix-fadvise-sync-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "posix-fadvise-sync-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.posix-fadvise-sync-runtime.checks.runtime}
            test -e ${self.posix-fadvise-sync-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    posix-fadvise-sync-runtime-wasm64 = self.posix-fadvise-sync-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    sendfile-runtime = callPackage ./sendfile-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "sendfile-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sendfile-runtime.checks.runtime}
            test -e ${self.sendfile-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    sendfile-runtime-wasm64 = self.sendfile-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    openat2-resolve-runtime = callPackage ./openat2-resolve-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "openat2-resolve-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.openat2-resolve-runtime.checks.runtime}
            test -e ${self.openat2-resolve-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    openat2-resolve-runtime-wasm64 = self.openat2-resolve-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    process-group-session-runtime = callPackage ./process-group-session-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "process-group-session-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.process-group-session-runtime.checks.runtime}
            test -e ${self.process-group-session-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    process-group-session-runtime-wasm64 = self.process-group-session-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    waitid-stopped-continued-runtime = callPackage ./waitid-stopped-continued-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "waitid-stopped-continued-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.waitid-stopped-continued-runtime.checks.runtime}
            test -e ${self.waitid-stopped-continued-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    waitid-stopped-continued-runtime-wasm64 = self.waitid-stopped-continued-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    symlink-readlink-realpath-runtime = callPackage ./symlink-readlink-realpath-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "symlink-readlink-realpath-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.symlink-readlink-realpath-runtime.checks.runtime}
            test -e ${self.symlink-readlink-realpath-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    symlink-readlink-realpath-runtime-wasm64 = self.symlink-readlink-realpath-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    posix-spawn-cloexec-sigmask-runtime = callPackage ./posix-spawn-cloexec-sigmask-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "posix-spawn-cloexec-sigmask-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.posix-spawn-cloexec-sigmask-runtime.checks.runtime}
            test -e ${self.posix-spawn-cloexec-sigmask-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    posix-spawn-cloexec-sigmask-runtime-wasm64 = self.posix-spawn-cloexec-sigmask-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    fcntl-dupfd-cloexec-flags-runtime =
      callPackage ./fcntl-dupfd-cloexec-flags-runtime/package.nix
        {
          extraChecks.both =
            pkgs.runCommand "fcntl-dupfd-cloexec-flags-runtime-check-both"
              {
                passthru.ci.heavy = true;
              }
              ''
                test -e ${self.fcntl-dupfd-cloexec-flags-runtime.checks.runtime}
                test -e ${self.fcntl-dupfd-cloexec-flags-runtime-wasm64.checks.runtime}
                touch $out
              '';
        };
    fcntl-dupfd-cloexec-flags-runtime-wasm64 = self.fcntl-dupfd-cloexec-flags-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    memfd-seals-runtime = callPackage ./memfd-seals-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "memfd-seals-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.memfd-seals-runtime.checks.runtime}
        test -e ${self.memfd-seals-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    memfd-seals-runtime-wasm64 = self.memfd-seals-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    inotify-runtime = callPackage ./inotify-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "inotify-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.inotify-runtime.checks.runtime}
        test -e ${self.inotify-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    inotify-runtime-wasm64 = self.inotify-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    mqueue-runtime = callPackage ./mqueue-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "mqueue-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.mqueue-runtime.checks.runtime}
        test -e ${self.mqueue-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    mqueue-runtime-wasm64 = self.mqueue-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    sysvipc-runtime = callPackage ./sysvipc-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "sysvipc-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.sysvipc-runtime.checks.runtime}
        test -e ${self.sysvipc-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    sysvipc-runtime-wasm64 = self.sysvipc-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    kallsyms-runtime = callPackage ./kallsyms-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "kallsyms-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.kallsyms-runtime.checks.runtime}
        test -e ${self.kallsyms-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    kallsyms-runtime-wasm64 = self.kallsyms-runtime.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    libgit2-runtime = callPackage ./libgit2-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "libgit2-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.libgit2-runtime.checks.runtime}
        test -e ${self.libgit2-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    libgit2-runtime-wasm64 = self.libgit2-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      zlib = self.zlib-wasm64;
      openssl = self.openssl-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    libuv-runtime = callPackage ./libuv-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "libuv-runtime-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.libuv-runtime.checks.runtime}
        test -e ${self.libuv-runtime-wasm64.checks.runtime}
        touch $out
      '';
    };
    libuv-runtime-wasm64 = self.libuv-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    openssl = callPackage ./openssl/package.nix { };
    openssl-wasm64 = self.openssl.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    openssl-dynamic = callPackage ./openssl-dynamic/package.nix {
      extraChecks.both = pkgs.runCommand "openssl-dynamic-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.openssl-dynamic.checks.runtime}
        test -e ${self.openssl-dynamic-wasm64.checks.runtime}
        touch $out
      '';
    };
    openssl-dynamic-wasm64 = self.openssl-dynamic.override {
      platform = self.platform-wasm64;
      openssl = self.openssl-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    openssl-fork = callPackage ./openssl-fork/package.nix {
      extraChecks.both = pkgs.runCommand "openssl-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.fork-poll-automatic-libc.checks.both}
        test -e ${self.openssl-fork.checks.runtime}
        test -e ${self.openssl-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    openssl-fork-wasm64 = self.openssl-fork.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      openssl = self.openssl-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    rsync-fork = callPackage ./rsync-fork/package.nix {
      # Match the polling runtime used by the static ACL dependency.
      sdk-fork-automatic = self.sdk-fork-automatic-poll-libc;
      extraChecks.both = pkgs.runCommand "rsync-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.rsync-fork.checks.runtime}
        test -e ${self.rsync-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    rsync-fork-wasm64 = self.rsync-fork.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      acl-runtime = self.acl-runtime-wasm64;
      extraChecks = { };
    };
    m4-fork = callPackage ./m4-fork/package.nix {
      extraChecks.both = pkgs.runCommand "m4-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.m4-fork.checks.runtime}
        test -e ${self.m4-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    m4-fork-wasm64 = self.m4-fork.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    patch = callPackage ./patch/package.nix { };
    python = callPackage ./python/package.nix { };
    python-wasm64 = self.python.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      zlib = self.zlib-wasm64;
      bzip2 = self.bzip2-wasm64;
      xz = self.xz-wasm64;
      # Use the installed archive/headers, not the CLI output or a wasm32 lib.
      # Loadable extensions and WAL remain disabled in this SQLite profile.
      sqlite3 = self.sqlite3-wasm64.dev;
      readline = self.readline-wasm64;
      ncurses = self.ncurses-wasm64;
      openssl = self.openssl-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    python-fork = callPackage ./python-fork/package.nix {
      extraChecks.both =
        pkgs.runCommand "python-standard-fork-check-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.fork-automatic.checks.both}
            test -e ${self.python-fork.checks.runtime}
            test -e ${self.python-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    python-fork-wasm64 = callPackage ./python-fork/package.nix {
      platform = self.platform-wasm64;
      python = self.python-wasm64;
      stdenv-fork-automatic = self.stdenv-fork-automatic-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    python-dynamic = callPackage ./python-dynamic/package.nix { };
    python-dynamic-wasm64 = callPackage ./python-dynamic/package.nix {
      python = self.python-wasm64;
      stdenv-dynamic-loader = self.stdenv-dynamic-loader-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
    };
    python-extension-runtime = callPackage ./python-extension-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "python-extension-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            test -e ${self.python-extension-runtime.checks.runtime}
            test -e ${self.python-extension-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    python-extension-runtime-wasm64 = callPackage ./python-extension-runtime/package.nix {
      platform = self.platform-wasm64;
      python-dynamic = self.python-dynamic-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    cxx-dynamic-runtime = callPackage ./cxx-dynamic-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "cxx-dynamic-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.dynamic-driver.checks.build}
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.cxx-dynamic-runtime.checks.runtime}
            test -e ${self.cxx-dynamic-runtime-wasm64.checks.runtime}
            test -e ${self.dynamic-loader.checks.runtime}
            test -e ${self.dynamic-loader-wasm64.checks.runtime}
            test -e ${self.libltdl-runtime.checks.runtime}
            test -e ${self.libltdl-runtime-wasm64.checks.runtime}
            test -e ${self.sqlite3-extension-runtime.checks.runtime}
            test -e ${self.sqlite3-extension-runtime-wasm64.checks.runtime}
            test -e ${self.python-extension-runtime.checks.runtime}
            test -e ${self.python-extension-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    dladdr-runtime = callPackage ./dladdr-runtime/package.nix {
      extraChecks.both = pkgs.runCommand "dladdr-runtime-both-widths" { passthru.ci.heavy = true; } ''
        test -e ${self.sdk-dynamic-loader.checks.driver}
        test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
        test -e ${self.dladdr-runtime.checks.runtime}
        test -e ${self.dladdr-runtime-wasm64.checks.runtime}
        test -e ${self.dynamic-loader.checks.runtime}
        test -e ${self.dynamic-loader-wasm64.checks.runtime}
        touch $out
      '';
    };
    dladdr-runtime-wasm64 = callPackage ./dladdr-runtime/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    cxx-dynamic-runtime-wasm64 = callPackage ./cxx-dynamic-runtime/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      musl = self.musl-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    expat-runtime = callPackage ./expat-runtime/package.nix { };
    expat-runtime-wasm64 = self.expat-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    libjpeg-runtime = callPackage ./libjpeg-runtime/package.nix { };
    libjpeg-runtime-wasm64 = self.libjpeg-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    libpng-runtime = callPackage ./libpng-runtime/package.nix { };
    libpng-runtime-wasm64 = self.libpng-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      zlib = self.zlib-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    libarchive-runtime = callPackage ./libarchive-runtime/package.nix { };
    libarchive-runtime-wasm64 = self.libarchive-runtime.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      zlib = self.zlib-wasm64;
      acl-runtime = self.acl-runtime-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    quickjs = callPackage ./quickjs/package.nix { };
    quickjs-wasm64 = self.quickjs.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    readline = callPackage ./readline/package.nix { };
    readline-wasm64 = self.readline.override {
      stdenv = self.stdenv-wasm64;
      ncurses = self.ncurses-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    rust-smoke = callPackage ./rust-smoke/package.nix { };
    sed = callPackage ./sed/package.nix { };
    sjlj-lto = callPackage ./sjlj-lto/package.nix { };
    sjlj-lto-wasm64 = self.sjlj-lto.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      vm-test = vmTestWasm64;
    };
    sjlj-lto-dynamic = self.sjlj-lto.override {
      sdk = self.sdk-dynamic-loader;
      cc = "${self.sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc";
      cxx = "${self.sdk-dynamic-loader}/bin/wasm-linux-dlopen-c++";
    };
    sjlj-lto-dynamic-wasm64 = self.sjlj-lto.override {
      platform = self.platform-wasm64;
      sdk = self.sdk-dynamic-loader-wasm64;
      cc = "${self.sdk-dynamic-loader-wasm64}/bin/wasm-linux-dlopen-cc";
      cxx = "${self.sdk-dynamic-loader-wasm64}/bin/wasm-linux-dlopen-c++";
      vm-test = vmTestWasm64;
    };
    sqlite3 = callPackage ./sqlite3/package.nix { };
    sqlite3-wasm64 = callPackage ./sqlite3/native-wasm64.nix {
      vm-test = vmTestWasm64;
    };
    sqlite3-dynamic = callPackage ./sqlite3-dynamic/package.nix { };
    sqlite3-dynamic-wasm64 = callPackage ./sqlite3-dynamic/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
    };
    sqlite3-extension-runtime = callPackage ./sqlite3-extension-runtime/package.nix {
      extraChecks.both =
        pkgs.runCommand "sqlite3-extension-runtime-check-both"
          {
            passthru.ci.heavy = true;
          }
          ''
            test -e ${self.sdk-dynamic-loader.checks.driver}
            test -e ${self.sdk-dynamic-loader-wasm64.checks.driver}
            test -e ${self.sqlite3-extension-runtime.checks.runtime}
            test -e ${self.sqlite3-extension-runtime-wasm64.checks.runtime}
            touch $out
          '';
    };
    sqlite3-extension-runtime-wasm64 = callPackage ./sqlite3-extension-runtime/package.nix {
      platform = self.platform-wasm64;
      sqlite3-dynamic = self.sqlite3-dynamic-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
    };
    tmux-fork = callPackage ./tmux-fork/package.nix {
      extraChecks.both = pkgs.runCommand "tmux-fork-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.tmux-fork.checks.runtime}
        test -e ${self.tmux-fork-wasm64.checks.runtime}
        touch $out
      '';
    };
    tmux-fork-wasm64 = self.tmux-fork.override {
      platform = self.platform-wasm64;
      sdk-fork-automatic-poll-libc = self.sdk-fork-automatic-poll-libc-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      musl = self.musl-wasm64;
      ncurses = self.ncurses-wasm64;
      libevent-runtime = self.libevent-runtime-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    tar = callPackage ./tar/package.nix { };
    tar-fork = callPackage ./tar-fork/package.nix {
      extraChecks.both = pkgs.runCommand "tar-standard-fork-both" { passthru.ci.heavy = true; } ''
        test -e ${self.tar-fork.checks.runtime}
        test -e ${self.tar-fork-wasm64.checks.runtime}
        touch $out
      '';
      extraChecks.process-tools-both =
        pkgs.runCommand "gnu-standard-process-tools-both" { passthru.ci.heavy = true; }
          ''
            test -e ${self.findutils-fork.checks.runtime}
            test -e ${self.findutils-fork-wasm64.checks.runtime}
            test -e ${self.tar-fork.checks.runtime}
            test -e ${self.tar-fork-wasm64.checks.runtime}
            touch $out
          '';
    };
    tar-fork-wasm64 = callPackage ./tar-fork/package.nix {
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      sdk-fork-automatic = self.sdk-fork-automatic-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    util-linux = callPackage ./util-linux/package.nix { };
    util-linux-wasm64 = self.util-linux.override {
      platform = self.platform-wasm64;
      stdenv = self.stdenv-wasm64;
      file = self.file-wasm64;
      zlib = self.zlib-wasm64;
      ncurses = self.ncurses-wasm64;
      readline = self.readline-wasm64;
      # Consume the installed target archive and relocatable pkg-config data,
      # not the SQLite CLI output or a library from the default wasm32 scope.
      sqlite3 = self.sqlite3-wasm64.dev;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    vim = callPackage ./vim/package.nix { };
    vim-wasm64 = self.vim.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      ncurses = self.ncurses-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    xz = callPackage ./xz/package.nix { };
    xz-wasm64 = self.xz.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    xz-threads = callPackage ./xz-threads/package.nix {
      extraChecks.both = pkgs.runCommand "xz-threads-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.xz-threads.checks.runtime}
        test -e ${self.xz-threads-wasm64.checks.runtime}
        touch $out
      '';
    };
    xz-threads-wasm64 = self.xz-threads.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      xz = self.xz-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    zlib = callPackage ./zlib/package.nix { };
    zlib-wasm64 = self.zlib.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    zstd-threads = callPackage ./zstd-threads/package.nix {
      extraChecks.both = pkgs.runCommand "zstd-threads-check-both" { passthru.ci.heavy = true; } ''
        test -e ${self.zstd-threads.checks.runtime}
        test -e ${self.zstd-threads-wasm64.checks.runtime}
        touch $out
      '';
    };
    zstd-threads-wasm64 = self.zstd-threads.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      sdk = self.sdk-wasm64;
      zstd = self.zstd-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
      extraChecks = { };
    };
    zstd = callPackage ./zstd/package.nix {
      vm-test-closed = vmTestClosed32;
      vm-test-file = self.vm-test.override {
        kernel = self.kernel.override {
          linux = self.linux.override {
            fileMmapCandidate = true;
            fileMmapStreamCandidate = false;
          };
        };
      };
    };
    zstd-wasm64 = self.zstd.override {
      image = self.image-wasm64;
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      platform = self.platform-wasm64;
      vm-test = vmTestWasm64;
      vm-test-closed = vmTestClosed64;
      vm-test-file = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override {
            fileMmapCandidate = true;
            fileMmapStreamCandidate = false;
          };
        };
      };
    };

    # Early platform tests boot without the guest agent so a broken SDK cannot
    # hide whether the kernel and libc reached userspace correctly.
    vm-test = callPackage ./vm-test/package.nix { };

    # Shared immutable filesystem construction. Product-specific images remain
    # owned by their consumer packages.
    image = callPackage ./image { };

    site = callPackage ./site { repository = bootstrapRepository; };
    bridge-site = callPackage ../packages/bridge-site { };

    apk-checks = callPackage ./apk/checks.nix { };
    repository = (callPackage ./repository.nix { bootFiles = self.site.bootFiles; }) // {
      checks = {
        inherit (self.apk-checks)
          architecture
          install
          store-references
          userland
          ;
      };
    };

    # The private guest protocol and its JavaScript SDK ship together.
    guest-agent = callPackage ./guest-agent/package.nix { };
    ltp = callPackage ./ltp/package.nix { };
    kselftests = callPackage ./kselftests/package.nix { };
    node-workspace = callPackage ./npm/node-workspace.nix { };
    playwright = callPackage ./npm/playwright.nix { };
    linux-guest = callPackage ./npm/linux-guest { repository = bootstrapRepository; };
    runner = callPackage ./npm/runner { };
    browser-tests = callPackage ./npm/browser-tests.nix { };
    wasm64-example = callPackage ./wasm64-example/package.nix { };
    wasm64-python-example = self.wasm64-example.override { withPython = true; };
    wasm64-python-git-example = self.wasm64-example.override {
      withPython = true;
      withGit = true;
    };
  }
)
