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
    rev = "cd7dc871fb877409c469f069e3ea8e006c477944";
    hash = "sha256-obOP8SjbpCgBFx3XebtYHQdR4LGsc4JO68ZmOPjzCw0=";
  },
}:

let
  platform = import ../platform.nix { inherit lib wasmBits; };
in
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
      # LLVM 22 requires an explicit policy for the executable-owned heap
      # globals and SjLj tag used by the retained PIC libc.so output. This
      # affects its link only; ordinary executables keep strict resolution.
      LDFLAGS_AUTO=-Wl,--unresolved-symbols=import-dynamic,--shared-memory,--import-memory,--max-memory=${toString platform.maximumMemoryBytes}
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
