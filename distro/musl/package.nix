{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  enableForkContinuation ? false,
  enableDynamicLoader ? false,
  enableBrkSyscall ? false,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "4bad222d065a160e75dcf2857ea71e940f1a1a4e";
    hash = "sha256-sAUt/O868JxUb8k6hOdWUiRjjkpnVoip7wYB7EFzGHc=";
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
      }${lib.optionalString enableForkContinuation " -DWASM_FORK_CONTINUATION=1"}${lib.optionalString enableDynamicLoader " -DWASM_DYNAMIC_LOADER=1"}${lib.optionalString enableBrkSyscall " -DWASM_BRK_SYSCALL=1"}
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
