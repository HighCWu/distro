{
  pkgs,
  lib,
  debug,
  wasmBits ? 32,
  llvm-toolchain-unwrapped,
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "musl";
    rev = "b368b62a769c79cfdd2128df6763981ae3815b7d";
    hash = "sha256-2rMUJpJKB+pR5xJwLpWC6LZe9AdE9sp6AhluR/OsyGA=";
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
    CFLAGS=${lib.optionalString debug "-g"}
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
