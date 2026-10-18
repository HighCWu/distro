{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  enableForkContinuation ? false,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "4776ccd09932e2d86d0b221108145bf2ca11128e";
    hash = "sha256-oH0G7cXz8tlh4AtaKIUacURVCy4njq5yt3k+xz7onOE=";
  },
}:

assert builtins.elem wasmBits [
  32
  64
];

pkgs.stdenvNoCC.mkDerivation (
  {
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
      }${lib.optionalString enableForkContinuation " -DWASM_FORK_CONTINUATION=1"}
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
  // lib.optionalAttrs enableForkContinuation {
    patches = [ ./fork-continuation.patch ];
    postPatch = ''
      mkdir -p src/process/wasm32
      cp ${./fork-continuation.c} src/process/wasm32/fork_continuation.c
    '';
  }
)
