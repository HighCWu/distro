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
    platform-wasm64 = callPackage ./platform.nix { wasmBits = 64; };
    linux = callPackage ./linux/package.nix { };
    linux-wasm64 = self.linux.override { wasmBits = 64; };
    bytes = callPackage ./npm/bytes.nix { };
    kernel = callPackage ./npm/kernel.nix { };
    kernel-wasm64 = self.kernel.override { linux = self.linux-wasm64; };
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
    packet-sockets-wasm64 = callPackage ./packet-sockets/package.nix {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
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
    erofs-metadata = callPackage ./erofs-metadata/package.nix { };
    erofs-metadata-wasm64 = callPackage ./erofs-metadata/package.nix {
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
    sdk-fork-cooperative-poll = self.sdk-fork-continuation.override { cooperativePoll = true; };
    sdk-fork-cooperative-poll-wasm64 = self.sdk-fork-continuation-wasm64.override {
      cooperativePoll = true;
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
    dash-fork = callPackage ./dash-fork/package.nix { };
    bash-fork = callPackage ./bash-fork/package.nix { };
    bash-fork-wasm64 = callPackage ./bash-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
    };
    dash-fork-wasm64 = callPackage ./dash-fork/package.nix {
      platform = self.platform-wasm64;
      sdk-fork-continuation = self.sdk-fork-continuation-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
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
    busybox = callPackage ./busybox/package.nix { };
    busybox-wasm64 = self.busybox.override {
      stdenv = self.stdenv-wasm64;
      musl = self.musl-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      platform = self.platform-wasm64;
      linux = self.linux-wasm64;
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
    gawk = callPackage ./gawk/package.nix { };
    git = callPackage ./git/package.nix { };
    git-wasm64 = self.git.override {
      stdenv = self.stdenv-wasm64;
      platform = self.platform-wasm64;
      busybox = self.busybox-wasm64;
      zlib = self.zlib-wasm64;
      curl = self.curl-wasm64;
      openssl = self.openssl-wasm64;
      vm-test = vmTestWasm64;
    };
    grep = callPackage ./grep/package.nix { };
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
    make = callPackage ./make/package.nix { };
    ncurses = callPackage ./ncurses/package.nix { };
    ncurses-wasm64 = self.ncurses.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
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
    cxx-dynamic-runtime-wasm64 = callPackage ./cxx-dynamic-runtime/package.nix {
      platform = self.platform-wasm64;
      sdk-dynamic-loader = self.sdk-dynamic-loader-wasm64;
      llvm-runtimes = self.llvm-runtimes-wasm64;
      musl = self.musl-wasm64;
      vm-test = vmTestWasm64;
      busybox = self.busybox-wasm64;
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
    sqlite3 = callPackage ./sqlite3/package.nix { };
    sqlite3-wasm64 = callPackage ./sqlite3/native-wasm64.nix {
      vm-test = vmTestWasm64;
    };
    sqlite3-dynamic = callPackage ./sqlite3-dynamic/package.nix { };
    sqlite3-dynamic-wasm64 = callPackage ./sqlite3-dynamic/package.nix {
      platform = self.platform-wasm64;
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
    tar = callPackage ./tar/package.nix { };
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
    zlib = callPackage ./zlib/package.nix { };
    zlib-wasm64 = self.zlib.override {
      stdenv = self.stdenv-wasm64;
      busybox = self.busybox-wasm64;
      vm-test = vmTestWasm64;
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
