{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  enableForkContinuation ? false,
  enableDynamicLoader ? false,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "7b077a6d549f1cbe97b22545e37cf1919dd6a641";
    hash = "sha256-5tD0pAVUpnvC8B3jbZNp/B3lzbsRu8xttlnUHQrwTME=";
  },
}:

assert builtins.elem wasmBits [
  32
  64
];
assert !(enableForkContinuation && enableDynamicLoader);

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
      }${lib.optionalString enableForkContinuation " -DWASM_FORK_CONTINUATION=1"}${lib.optionalString enableDynamicLoader " -DWASM_DYNAMIC_LOADER=1"}
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
  // lib.optionalAttrs (enableForkContinuation || enableDynamicLoader) {
    patches =
      lib.optional enableForkContinuation ./fork-continuation.patch
      ++ lib.optional enableDynamicLoader ./dynamic-loader.patch;
  }
)
