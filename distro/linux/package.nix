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
    rev = "2ee52fc40fe2f99d33f3cf1b4ff1b5601fe75f8b";
    hash = "sha256-UgQIyrPVX5I8M5wybxXud/nZ5yaBH6sgQYQWETkqB0w=";
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
