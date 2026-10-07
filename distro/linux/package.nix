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
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "linux";
    rev = "83df39cb39375ac0e017a804c20cbfc3ef7e5e20";
    hash = "sha256-z8LRscnYmaMIOXp02N+Rnpmq1/+algI0et59+H5IV+A=";
  },
}:

assert lib.assertOneOf "wasmBits" wasmBits [
  32
  64
];

pkgs.stdenvNoCC.mkDerivation {
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

    make headers_install INSTALL_HDR_PATH=$headers

    runHook postBuild
  '';

  installPhase = "runHook preInstall; runHook postInstall";
}
