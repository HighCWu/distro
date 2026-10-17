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
  llvm-toolchain-unwrapped,
  src ? import ./fetch-source.nix {
    inherit pkgs;
    owner = "HighCWu";
    repo = "linux";
    rev = "e81f9ad0e25670bb5fc4608b4c0b7e92b2ecb89e";
    hash = "sha256-VO8dOvelvkFQwELYLfGHk8igT9BNyLT+MwBEEQcwOEA=";
  },
}:

let
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
      inherit wasmBits debug mmapCopyTest;
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
  ];

  buildPhase = ''
    runHook preBuild

    make() {
      command make -j$NIX_BUILD_CORES HOSTCC=${pkgs.llvmPackages_22.clang}/bin/clang "$@"
    }

    make mrproper
    mkdir -p $out

    make wasm${toString wasmBits}_defconfig ${lib.optionalString debug "debug.config"}
    ${lib.optionalString mmapCopyTest ''
      scripts/config --enable WASM_MMAP_COPY_TEST
      make olddefconfig
    ''}

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
        jq --exit-status '.schemaVersion == 1 and .wasmBits == ${toString wasmBits} and .debug == ${builtins.toJSON debug} and .mmapCopyTest == ${builtins.toJSON mmapCopyTest}' linux-build/build.json
            test -s linux-build/kernel.config
            test -s linux-build/LICENSES/preferred/GPL-2.0
            touch $out
      '';
})
