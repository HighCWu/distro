# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  llvmToolchain,
  sysroot32,
  sysroot64,
}:
let
  consumer = pkgs.llvmPackages_22.stdenv.mkDerivation {
    pname = "clang-tooling-probe";
    version = "1";
    src = ./.;
    nativeBuildInputs = [
      pkgs.cmake
      pkgs.ninja
    ];
    buildInputs = [ llvmToolchain ];

    configurePhase = ''
      runHook preConfigure
      cmake -S "$src" -B build -G Ninja \
        -DCMAKE_CXX_COMPILER="$CXX" \
        -DLLVM_DIR=${lib.escapeShellArg "${llvmToolchain}/lib/cmake/llvm"} \
        -DClang_DIR=${lib.escapeShellArg "${llvmToolchain}/lib/cmake/clang"} \
        -DCMAKE_BUILD_RPATH=${lib.escapeShellArg "${llvmToolchain}/lib"} \
        -DCMAKE_INSTALL_RPATH=${lib.escapeShellArg "${llvmToolchain}/lib"}
      runHook postConfigure
    '';

    buildPhase = ''
      runHook preBuild
      cmake --build build -j$NIX_BUILD_CORES
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      cmake --install build --prefix "$out"
      runHook postInstall
    '';

    meta = {
      description = "Native LibTooling consumer for Wasm target ABI checks";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
    };
  };

  runtimeCheck =
    pkgs.runCommand "clang-tooling-target-abi-check"
      {
        passthru.ci.heavy = true;
      }
      ''
        LD_LIBRARY_PATH=${lib.escapeShellArg "${llvmToolchain}/lib"} \
        ${consumer}/bin/clang-tooling-probe \
          ${lib.escapeShellArg "${sysroot32}"} \
          ${lib.escapeShellArg "${sysroot64}"}
        touch $out
      '';
in
consumer.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    checks.tooling = runtimeCheck;
  };
})
