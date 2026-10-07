{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "1a4641256199a515f580375b94cbf5e960337243";
    hash = "sha256-I9DmTmLFNa53xkKpVuW/O/u/LQ03qixDYIZiAbwFYC8=";
  },
}:

assert builtins.elem wasmBits [
  32
  64
];

pkgs.stdenvNoCC.mkDerivation {
  name = "musl-wasm${toString wasmBits}";
  inherit src;

  nativeBuildInputs = [ llvm-toolchain-unwrapped ];

  # TODO: split for size, only relevant for dynamic linking
  # outputs = [ "out" "dev" ];
  configurePhase = ''
    runHook preConfigure

    cat >config.mak <<EOF
    ARCH=wasm32
    WASM_BITS=${toString wasmBits}
    prefix=$out
    syslibdir=$out
    CFLAGS=${lib.optionalString debug "-g"}${
      lib.optionalString (!deduplicateMmapSearch) " -DWASM_MMAP_DEDUP_SEARCH=0"
    }
    EOF

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make clean
    make -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir $out
    make -j$NIX_BUILD_CORES install-libs install-headers
    runHook postInstall
  '';
}
