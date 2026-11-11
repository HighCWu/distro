# clang/lld for the build platform, from the HighCWu/llvm-project fork whose
# wasm-linux branch carries the wasm32-unknown-linux-musl target.
{
  pkgs,
  includeHostBackend ? true,
  enableLibTooling ? false,
  patches ? [ ],
  src ? pkgs.fetchFromGitHub {
    owner = "HighCWu";
    repo = "llvm-project";
    rev = "7f640bd616bf9844e7e5647bbfb5e2d38bc55168";
    hash = "sha256-0qLn1D0oPJg3EsPsEgGCRj+GsUpXvx7LUr6zLTA28/c=";
  },
}:

let
  llvmPackages = pkgs.llvmPackages_22;

  nativeTarget =
    if pkgs.stdenv.hostPlatform.isx86_64 then
      "X86"
    else if pkgs.stdenv.hostPlatform.isAarch64 then
      "AArch64"
    else
      throw "unsupported LLVM host target: ${pkgs.stdenv.hostPlatform.config}";

  sharedToolingFlags =
    if enableLibTooling then
      [
        "-DLLVM_BUILD_LLVM_DYLIB=ON"
        "-DLLVM_LINK_LLVM_DYLIB=ON"
        "-DCLANG_LINK_CLANG_DYLIB=ON"
      ]
    else
      [
        "-DLLVM_BUILD_LLVM_DYLIB=OFF"
        "-DLLVM_LINK_LLVM_DYLIB=OFF"
        "-DCLANG_LINK_CLANG_DYLIB=OFF"
      ];

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DCMAKE_C_COMPILER=${llvmPackages.clang}/bin/clang"
    "-DCMAKE_CXX_COMPILER=${llvmPackages.clang}/bin/clang++"
    "-DCMAKE_AR=${llvmPackages.llvm}/bin/llvm-ar"
    "-DCMAKE_RANLIB=${llvmPackages.llvm}/bin/llvm-ranlib"
    "-DLLVM_ENABLE_PROJECTS=clang;lld"
    "-DLLVM_ENABLE_RUNTIMES="
    "-DBUILD_SHARED_LIBS=OFF"
  ]
  ++ sharedToolingFlags
  ++ [
    "-DLIBCLANG_BUILD_STATIC=ON"
    "-DLLVM_INCLUDE_BENCHMARKS=OFF"
    "-DLLVM_INCLUDE_TESTS=OFF"
    "-DLLVM_INCLUDE_DOCS=OFF"
    "-DCLANG_INCLUDE_TESTS=OFF"
    "-DCLANG_INCLUDE_DOCS=OFF"
    "-DLLVM_TOOL_LLVM_EXEGESIS_BUILD=OFF"
    "-DLLVM_INSTALL_BINUTILS_SYMLINKS=ON"
    "-DLLVM_INSTALL_UTILS=ON"
    "-DCLANG_DEFAULT_RTLIB=compiler-rt"
    "-DCLANG_DEFAULT_CXX_STDLIB=libc++"
    "-DCLANG_DEFAULT_LINKER=lld"
    "-DLLVM_TARGETS_TO_BUILD=${if includeHostBackend then "${nativeTarget};" else ""}WebAssembly"
    "-DLLVM_ENABLE_LIBXML2=ON"
    "-DLLVM_ENABLE_ZLIB=ON"
    "-DLLVM_ENABLE_ZSTD=OFF"
    "-DLLVM_ENABLE_TERMINFO=ON"
    "-DLLVM_ENABLE_LIBEDIT=OFF"
    "-DLLVM_BUILD_UTILS=ON"
  ];
in

llvmPackages.stdenv.mkDerivation {
  pname = if enableLibTooling then "llvm-toolchain-development" else "llvm-toolchain-unwrapped";
  version = llvmPackages.release_version;
  inherit src patches;

  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.perl
    pkgs.python3
  ];

  buildInputs = [
    pkgs.libffi
    pkgs.libxml2
    pkgs.ncurses
    pkgs.zlib
  ];

  configurePhase = ''
    runHook preConfigure
    cmake -S llvm -B build -G Ninja -DCMAKE_INSTALL_PREFIX=$out ${pkgs.lib.escapeShellArgs cmakeFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    cmake --build build --target install -j$NIX_BUILD_CORES
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    ln -sf clang $out/bin/cc
    ln -sf clang++ $out/bin/c++
    ln -sf ld.lld $out/bin/ld
    runHook postInstall
  '';
}
