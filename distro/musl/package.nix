{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  deduplicateMmapSearch ? true,
  generationMmapSearch ? false,
  generationEpochLimit ? null,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "fe9e88b15b18d04aa6661e0c8e19b66b99cbc833";
    hash = "sha256-CIKZ59v6rl9ll38Zb2fZtTFd/c0uuM3xYjZkq6H3GGg=";
  },
}:

assert builtins.elem wasmBits [
  32
  64
];
assert !generationMmapSearch || deduplicateMmapSearch;
assert
  generationEpochLimit == null
  || (
    generationMmapSearch
    && builtins.isInt generationEpochLimit
    && generationEpochLimit > 0
    && (wasmBits != 32 || generationEpochLimit <= 4294967295)
  );

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
    }${lib.optionalString generationMmapSearch " -DWASM_MMAP_SEARCH_GENERATIONS=1"}${
      lib.optionalString (
        generationEpochLimit != null
      ) " -DWASM_MMAP_SEARCH_EPOCH_MAX=${toString generationEpochLimit}"
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
