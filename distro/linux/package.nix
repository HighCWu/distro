# The kernel is a build-platform artifact: a wasm blob and headers. The
# JavaScript host library lives in the repository's @lowland/kernel workspace
# package. This derivation uses explicit tools because kbuild drives its own
# cross setup rather than the wasm stdenv.
{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  mmapCopyTest ? false,
  fileMmapCandidate ? false,
  # Historical argument name; the verified streaming path is now the normal
  # build. Tests of the old bounded/closed policies must opt out explicitly.
  fileMmapStreamCandidate ? true,
  vtimeCandidate ? false,
  userNamespaceCandidate ? false,
  elfContainerCandidate ? false,
  checkpointRestoreCandidate ? false,
  llvm-toolchain-unwrapped,
  src ? import ./fetch-source.nix {
    inherit pkgs;
    owner = "HighCWu";
    repo = "linux";
    rev = "cf135c3ddea8af69f6d9e7949fe455772326f1d1";
    hash = "sha256-cyn3ZuMB72+t75WakR5OCbs0J34XhkYWMN2MA9GBl0c=";
  },
}:

let
  copyHostChecks = fileMmapCandidate || fileMmapStreamCandidate || mmapCopyTest;
  identity =
    value:
    let
      basename = builtins.baseNameOf "${value}";
    in
    {
      hashParts = [
        (builtins.substring 0 16 basename)
        (builtins.substring 16 16 basename)
      ];
      name = builtins.substring 33 (builtins.stringLength basename) basename;
    };
  buildMetadata = pkgs.writeText "linux-wasm-build.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit
        wasmBits
        debug
        mmapCopyTest
        fileMmapCandidate
        fileMmapStreamCandidate
        vtimeCandidate
        userNamespaceCandidate
        elfContainerCandidate
        checkpointRestoreCandidate
        ;
      sourceIdentity = identity src;
      llvmToolchainIdentity = identity llvm-toolchain-unwrapped;
      scope = "Exact kernel build materials; not a complete dependency inventory or corresponding-source archive";
    }
  );
in
assert lib.assertOneOf "wasmBits" wasmBits [
  32
  64
];

pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "linux-wasm${toString wasmBits}";
  version = "0.0.0";
  inherit src;

  outputs = [
    "out"
    "headers"
  ];

  # The outputs are wasm and headers: nixpkgs' fixup would strip nothing.
  dontFixup = true;

  nativeBuildInputs = [
    llvm-toolchain-unwrapped
    pkgs.bc
    pkgs.bison
    pkgs.findutils
    pkgs.flex
    pkgs.gnumake
    pkgs.perl
    pkgs.rsync
    pkgs.wabt
  ]
  ++ lib.optional copyHostChecks pkgs.python3;

  buildPhase = ''
    runHook preBuild

    ${lib.optionalString copyHostChecks ''
      CC=${pkgs.llvmPackages_22.clang}/bin/clang python3 -B arch/wasm/tests/run-mmap-file-host.py
    ''}

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang "$@"
    }

    make mrproper
    mkdir -p $out

    make wasm${toString wasmBits}_defconfig ${lib.optionalString debug "debug.config"}
    ${lib.optionalString mmapCopyTest ''
      scripts/config --enable WASM_MMAP_COPY_TEST
    ''}
    ${lib.optionalString (fileMmapCandidate || fileMmapStreamCandidate) ''
      scripts/config --enable WASM_FILE_MMAP
    ''}
    ${lib.optionalString fileMmapStreamCandidate ''
      scripts/config --enable WASM_FILE_MMAP_STREAM
    ''}
    ${lib.optionalString vtimeCandidate ''
      scripts/config --enable WASM_VTIME --disable TICK_CPU_ACCOUNTING \
        --enable VIRT_CPU_ACCOUNTING_GEN --enable CONTEXT_TRACKING_USER_FORCE
    ''}
    ${lib.optionalString userNamespaceCandidate ''
      scripts/config --enable USER_NS
    ''}
    ${lib.optionalString elfContainerCandidate ''
      scripts/config --enable WASM_ELF_CONTAINER
    ''}
    ${lib.optionalString checkpointRestoreCandidate ''
      scripts/config --enable CHECKPOINT_RESTORE
    ''}
    scripts/config --enable MEMFD_CREATE
    make olddefconfig
    ${
      if fileMmapCandidate || fileMmapStreamCandidate then
        ''
          grep -qx 'CONFIG_WASM_FILE_MMAP=y' .config
        ''
      else
        ''
          ! grep -qx 'CONFIG_WASM_FILE_MMAP=y' .config
        ''
    }
    ${
      if fileMmapStreamCandidate then
        ''
          grep -qx 'CONFIG_WASM_FILE_MMAP_STREAM=y' .config
        ''
      else
        ''
          ! grep -qx 'CONFIG_WASM_FILE_MMAP_STREAM=y' .config
        ''
    }

    ${
      if vtimeCandidate then
        ''
          for option in WASM_VTIME VIRT_CPU_ACCOUNTING_GEN CONTEXT_TRACKING_USER CONTEXT_TRACKING_USER_FORCE; do
            grep -qx "CONFIG_$option=y" .config
          done
          ! grep -qx 'CONFIG_TICK_CPU_ACCOUNTING=y' .config
        ''
      else
        ''
          ! grep -qx 'CONFIG_WASM_VTIME=y' .config
          ! grep -qx 'CONFIG_VIRT_CPU_ACCOUNTING_GEN=y' .config
        ''
    }

    # Verify the resolved Kconfig, not merely the input defconfig intent.
    grep -qx 'CONFIG_INOTIFY_USER=y' .config
    for option in KEYS BINFMT_MISC FANOTIFY FANOTIFY_ACCESS_PERMISSIONS; do
      if ! grep -qx "CONFIG_$option=y" .config; then
        echo "Missing required kernel config: CONFIG_$option=y" >&2
        exit 1
      fi
    done
    grep -qx 'CONFIG_FSNOTIFY=y' .config
    grep -qx 'CONFIG_EXT4_FS_POSIX_ACL=y' .config
    grep -qx 'CONFIG_FS_POSIX_ACL=y' .config
    grep -qx 'CONFIG_IPV6=y' .config
    grep -qx 'CONFIG_SYSVIPC=y' .config
    grep -qx 'CONFIG_FUSE_PASSTHROUGH=y' .config
    grep -qx 'CONFIG_MEMFD_CREATE=y' .config
    grep -qx 'CONFIG_FS_STACK=y' .config
    grep -qx 'CONFIG_VM_EVENT_COUNTERS=y' .config
    grep -qx 'CONFIG_PACKET=y' .config
    grep -qx 'CONFIG_BPF=y' .config
    grep -qx 'CONFIG_BPF_SYSCALL=y' .config
    for option in CGROUPS CGROUP_PIDS KERNFS; do
      grep -qx "CONFIG_$option=y" .config
    done
    for option in NAMESPACES UTS_NS IPC_NS PID_NS; do
      grep -qx "CONFIG_$option=y" .config
    done
    grep -qx 'CONFIG_BPF_UNPRIV_DEFAULT_OFF=y' .config
    ! grep -qx 'CONFIG_BPF_JIT=y' .config
    ! grep -qx 'CONFIG_BPF_JIT_ALWAYS_ON=y' .config
    for option in UNIX_DIAG INET_DIAG INET_TCP_DIAG INET_UDP_DIAG NETLINK_DIAG; do
      grep -qx "CONFIG_$option=y" .config
    done
    for option in CRYPTO CRYPTO_USER CRYPTO_USER_API_HASH CRYPTO_SHA256 CRYPTO_HMAC \
      CRYPTO_USER_API_SKCIPHER CRYPTO_AES CRYPTO_CBC CRYPTO_CTR \
      CRYPTO_USER_API_AEAD CRYPTO_GCM CRYPTO_USER_API_RNG \
      CRYPTO_DRBG_MENU CRYPTO_DRBG CRYPTO_DRBG_HMAC CRYPTO_SHA512; do
      grep -qx "CONFIG_$option=y" .config
    done
    ! grep -qx 'CONFIG_CRYPTO_USER_API_RNG_CAVP=y' .config
    grep -qx 'CONFIG_FHANDLE=y' .config
    for option in SECURITY SECURITY_NETWORK SECURITY_PATH SECURITY_LANDLOCK; do
      grep -qx "CONFIG_$option=y" .config
    done
    grep -E '^CONFIG_LSM="([^",]+,)*landlock(,[^",]+)*"$' .config
    grep -qx 'CONFIG_HAVE_ARCH_SECCOMP=y' .config
    grep -qx 'CONFIG_SECCOMP=y' .config
    ! grep -qx 'CONFIG_HAVE_ARCH_SECCOMP_FILTER=y' .config
    ! grep -qx 'CONFIG_SECCOMP_FILTER=y' .config
    for option in EROFS_FS_XATTR EROFS_FS_POSIX_ACL EROFS_FS_SECURITY EROFS_FS_BACKED_BY_FILE; do
      if ! grep -qx "CONFIG_$option=y" .config; then
        echo "Missing required kernel config: CONFIG_$option=y" >&2
        exit 1
      fi
    done
    grep -qx 'CONFIG_EXPORTFS=y' .config
    grep -qx 'CONFIG_DNOTIFY=y' .config
    grep -qx 'CONFIG_MEMBARRIER=y' .config
    grep -qx 'CONFIG_CROSS_MEMORY_ATTACH=y' .config
    for namespace in NAMESPACES UTS_NS IPC_NS PID_NS NET_NS TIME_NS; do
      grep -qx "CONFIG_$namespace=y" .config
    done
    ${
      if userNamespaceCandidate then
        ''
          grep -qx 'CONFIG_USER_NS=y' .config
        ''
      else
        ''
          grep -qx '# CONFIG_USER_NS is not set' .config
        ''
    }
    ${
      if elfContainerCandidate then
        ''
          grep -qx 'CONFIG_WASM_ELF_CONTAINER=y' .config
        ''
      else
        ''
          ! grep -qx 'CONFIG_WASM_ELF_CONTAINER=y' .config
        ''
    }
    ${
      if checkpointRestoreCandidate then
        ''
          grep -qx 'CONFIG_CHECKPOINT_RESTORE=y' .config
        ''
      else
        ''
          ! grep -qx 'CONFIG_CHECKPOINT_RESTORE=y' .config
        ''
    }
    ! grep -qx 'CONFIG_MMU=y' .config

    make vmlinux.wasm

    cp vmlinux.wasm $out/
    bash ${./build-materials.sh} "$PWD" "$out" ${./package.nix} \
      ${buildMetadata} ${./build-materials.README.md} ${./fetch-source.nix}

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
  # Fetch/unpack/hash validation only: no LLVM or kernel build dependency.
  passthru.checks.source =
    pkgs.runCommand "linux-pinned-source-check"
      {
        passthru.ci.heavy = true;
      }
      ''
        test -s ${src}/Makefile
        test -s ${src}/arch/wasm/Kconfig
        test -s ${src}/COPYING
        touch $out
      '';
  passthru.checks.build-materials =
    pkgs.runCommand "linux-wasm${toString wasmBits}-build-materials-check"
      {
        passthru.ci.heavy = true;
        nativeBuildInputs = [ pkgs.jq ];
      }
      ''
        cd ${finalAttrs.finalPackage}
        sha256sum --check linux-build/SHA256SUMS
        jq --exit-status '.schemaVersion == 1 and .wasmBits == ${toString wasmBits} and .debug == ${builtins.toJSON debug} and .mmapCopyTest == ${builtins.toJSON mmapCopyTest} and .fileMmapCandidate == ${builtins.toJSON fileMmapCandidate} and .fileMmapStreamCandidate == ${builtins.toJSON fileMmapStreamCandidate} and .vtimeCandidate == ${builtins.toJSON vtimeCandidate} and .elfContainerCandidate == ${builtins.toJSON elfContainerCandidate} and .checkpointRestoreCandidate == ${builtins.toJSON checkpointRestoreCandidate}' linux-build/build.json
            test -s linux-build/kernel.config
            test -s linux-build/LICENSES/preferred/GPL-2.0
            touch $out
      '';
})
