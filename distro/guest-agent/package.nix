{
  bytes,
  stdenv,
  pkgs,
  kernel,
  kernel-wasm64,
  image,
  node-workspace,
  sdk-wasm64,
  apk,
  platform-wasm64,
  apk-wasm64,
  busybox-wasm64,
  sqlite3-wasm64,
  python-wasm64,
  ncurses-wasm64,
  openssl-wasm64,
  ca-certificates,
  git-wasm64,
}:

let
  nativeWasm64 = import ./native-wasm64.nix {
    inherit
      apk
      apk-wasm64
      busybox-wasm64
      sqlite3-wasm64
      python-wasm64
      ncurses-wasm64
      openssl-wasm64
      ca-certificates
      git-wasm64
      image
      pkgs
      sdk-wasm64
      platform-wasm64
      ;
  };
  bootDiskCheckFor =
    extraRootPackages:
    import ./runtime-wasm64.nix {
      inherit
        bytes
        pkgs
        sdk-wasm64
        image
        node-workspace
        apk
        platform-wasm64
        ;
      kernel = kernel-wasm64;
      production = nativeWasm64;
      bootDisk = true;
      inherit extraRootPackages;
    };
  bootDiskCheck = bootDiskCheckFor { };
  userlandBootAssets = bootDiskCheckFor {
    busybox = apk-wasm64.packageFrom busybox-wasm64;
  };
  package = stdenv.mkDerivation {
    pname = "linux-guest-agent";
    version = "0.0.0";
    src = ./.;

    buildPhase = ''
      runHook preBuild
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -Wl,--fatal-warnings -o linux-guest-agent agent.c
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp linux-guest-agent $out/bin/linux-guest-agent
      runHook postInstall
    '';
  };

  # The host library's abi.ts is the single source of truth for guest ABI
  # facts (syscall numbers, struct layouts). This check compiles — never
  # runs — a generated file of _Static_asserts with the guest toolchain, so
  # any drift between abi.ts and the real headers is a build failure.
  abi = stdenv.mkDerivation {
    pname = "linux-guest-agent-abi-check";
    version = "0.0.0";
    src = ./.;
    nativeBuildInputs = [ pkgs.nodejs ];

    buildPhase = ''
      runHook preBuild
      mkdir -p node_modules/@lowland/bytes node_modules/@lowland/kernel
      cp ${../../packages/linux-guest/src/abi.ts} abi.ts
      cp -r ${bytes}/. node_modules/@lowland/bytes/
      cp -r ${kernel}/. node_modules/@lowland/kernel/
      echo '{"type":"module","dependencies":{"@lowland/bytes":"*","@lowland/kernel":"*"}}' > package.json
      node gen-abi-check.ts ./abi.ts > abi-check.c
      $CC -Wall -Wextra -Werror -Wno-error=unused-command-line-argument \
        -c abi-check.c -o abi-check.o
      runHook postBuild
    '';

    installPhase = "touch $out";
  };
in
package
// {
  inherit nativeWasm64;
  checks.abi = abi;
  checks.abi-wasm64 = import ./abi-wasm64.nix { inherit bytes pkgs sdk-wasm64; };
  checks.runtime-wasm64 = import ./runtime-wasm64.nix {
    inherit
      bytes
      pkgs
      sdk-wasm64
      image
      node-workspace
      ;
    kernel = kernel-wasm64;
  };
  checks.production-wasm64 = import ./runtime-wasm64.nix {
    inherit
      bytes
      pkgs
      sdk-wasm64
      image
      node-workspace
      apk
      platform-wasm64
      ;
    kernel = kernel-wasm64;
    production = nativeWasm64;
  };
  checks.boot-disk-wasm64 = bootDiskCheck;
  checks.public-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = bootDiskCheck;
  };
  checks.minimal-root-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = {
      runtimeBootDisk = nativeWasm64.bootDisk;
      runtimeRootfs = nativeWasm64.rootfs;
    };
    profile = "minimal-root";
    testFile = "agent-wasm64-minimal-root-runtime.ts";
  };
  checks.persistent-root-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = {
      runtimeBootDisk = nativeWasm64.bootDisk;
      runtimeRootfs = nativeWasm64.rootfsExt4;
    };
    profile = "persistent-root";
    testFile = "agent-wasm64-persistent-root-runtime.ts";
  };
  checks.sqlite-root-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = {
      runtimeBootDisk = nativeWasm64.bootDisk;
      runtimeRootfs = nativeWasm64.rootfsSqliteExt4;
    };
    profile = "sqlite-root";
    testFile = "agent-wasm64-sqlite-root-runtime.ts";
  };
  checks.git-root-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = {
      runtimeBootDisk = nativeWasm64.bootDisk;
      runtimeRootfs = nativeWasm64.rootfsGitExt4;
    };
    profile = "git-root";
    testFile = "agent-wasm64-git-root-runtime.ts";
  };
  checks.python-root-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = {
      runtimeBootDisk = nativeWasm64.bootDisk;
      runtimeRootfs = nativeWasm64.rootfsPythonExt4;
    };
    applicationArchive = "${python-wasm64.applicationExample}/application.pyz";
    profile = "python-root";
    testFile = "agent-wasm64-python-root-runtime.ts";
  };
  checks.public-userland-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = userlandBootAssets;
    userland = true;
  };
  checks.public-network-wasm64 = import ./public-wasm64.nix {
    inherit bytes pkgs node-workspace;
    kernel = kernel-wasm64;
    assets = userlandBootAssets;
    userland = true;
    networking = true;
  };
}
