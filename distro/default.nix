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
    stdenvReleaseWasm64 = import ./stdenv.nix {
      inherit pkgs;
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
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
    toolchain-smoke = callPackage ./toolchain-smoke/package.nix { };
    sdk = callPackage ./sdk/package.nix { };
    sdk-wasm64 = callPackage ./sdk/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    toolchain-smoke-runtime = self.toolchain-smoke.checks.c-runtime;
    toolchain-smoke-wasm64 = callPackage ./toolchain-smoke/package.nix {
      platform = self.platform-wasm64;
      llvm-toolchain = self.llvm-toolchain-wasm64;
      sysroot = self.sysroot-wasm64;
      vm-test = vmTestWasm64;
    };
    toolchain-smoke-runtime-wasm64 = self.toolchain-smoke-wasm64.checks.c-runtime;

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
          linux = self.linux.override { fileMmapCandidate = true; };
        };
      in
      callPackage ./mmap-benchmark/package.nix {
        inherit fileKernel;
        vm-test-file = self.vm-test.override {
          kernel = fileKernel;
        };
        vm-test-copy = self.vm-test.override {
          kernel = self.kernel.override {
            linux = self.linux.override { mmapCopyTest = true; };
          };
        };
      };
    mmap-benchmark-wasm64 =
      let
        fileKernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override { fileMmapCandidate = true; };
        };
      in
      callPackage ./mmap-benchmark/package.nix {
        inherit fileKernel;
        vm-test-file = vmTestWasm64.override {
          kernel = fileKernel;
        };
        platform = self.platform-wasm64;
        llvm-toolchain = self.llvm-toolchain-wasm64;
        sysroot = self.sysroot-wasm64;
        vm-test = vmTestWasm64;
        vm-test-copy = vmTestWasm64.override {
          kernel = self.kernel-wasm64.override {
            linux = self.linux-wasm64.override { mmapCopyTest = true; };
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
    ca-certificates = callPackage ./ca-certificates/package.nix { };
    coreutils = callPackage ./coreutils/package.nix { };
    curl = callPackage ./curl/package.nix { };
    diffutils = callPackage ./diffutils/package.nix { };
    dropbear = callPackage ./dropbear/package.nix { };
    e2fsprogs = callPackage ./e2fsprogs/package.nix { };
    file = callPackage ./file/package.nix { };
    findutils = callPackage ./findutils/package.nix { };
    gawk = callPackage ./gawk/package.nix { };
    git = callPackage ./git/package.nix { };
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
      vm-test = vmTestWasm64;
    };
    make = callPackage ./make/package.nix { };
    ncurses = callPackage ./ncurses/package.nix { };
    openssl = callPackage ./openssl/package.nix { };
    patch = callPackage ./patch/package.nix { };
    python = callPackage ./python/package.nix { };
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
    rust-smoke = callPackage ./rust-smoke/package.nix { };
    sed = callPackage ./sed/package.nix { };
    sqlite3 = callPackage ./sqlite3/package.nix { };
    sqlite3-wasm64 = callPackage ./sqlite3/native-wasm64.nix {
      vm-test = vmTestWasm64;
    };
    tar = callPackage ./tar/package.nix { };
    util-linux = callPackage ./util-linux/package.nix { };
    vim = callPackage ./vim/package.nix { };
    xz = callPackage ./xz/package.nix { };
    zlib = callPackage ./zlib/package.nix { };
    zstd = callPackage ./zstd/package.nix {
      vm-test-file = self.vm-test.override {
        kernel = self.kernel.override {
          linux = self.linux.override { fileMmapCandidate = true; };
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
      vm-test-file = vmTestWasm64.override {
        kernel = self.kernel-wasm64.override {
          linux = self.linux-wasm64.override { fileMmapCandidate = true; };
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
  }
)
