# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "expat-runtime-${platform.wasmArch}";
  inherit (pkgs.expat) src version;

  outputs = [
    "out"
    "buildMaterials"
  ];
  dontConfigure = true;
  dontCheck = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild

    cmake -S . -B build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=${platform.wasmArch} \
      -DCMAKE_C_COMPILER=${sdk}/bin/wasm-linux-cc \
      -DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS=-O2 \
      -DCMAKE_INSTALL_PREFIX="$out" \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DCMAKE_INSTALL_INCLUDEDIR=include \
      -DCMAKE_FIND_LIBRARY_SUFFIXES=.a \
      -DEXPAT_SHARED_LIBS:BOOL=OFF \
      -DEXPAT_BUILD_TOOLS:BOOL=OFF \
      -DEXPAT_BUILD_EXAMPLES:BOOL=OFF \
      -DEXPAT_BUILD_TESTS:BOOL=OFF \
      -DEXPAT_BUILD_DOCS:BOOL=OFF \
      -DEXPAT_BUILD_FUZZERS:BOOL=OFF \
      -DEXPAT_BUILD_PKGCONFIG:BOOL=OFF \
      -DEXPAT_ENABLE_INSTALL:BOOL=ON \
      -DEXPAT_CHAR_TYPE:STRING=char \
      -DEXPAT_NS:BOOL=ON

    grep -Fqx 'CMAKE_C_COMPILER:STRING=${sdk}/bin/wasm-linux-cc' build/CMakeCache.txt
    grep -Fqx 'CMAKE_AR:FILEPATH=${llvm-toolchain}/bin/llvm-ar' build/CMakeCache.txt
    grep -Fqx 'CMAKE_RANLIB:FILEPATH=${llvm-toolchain}/bin/llvm-ranlib' build/CMakeCache.txt
    grep -qx 'EXPAT_SHARED_LIBS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_TOOLS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_EXAMPLES:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_TESTS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_DOCS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_FUZZERS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_BUILD_PKGCONFIG:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'EXPAT_ENABLE_INSTALL:BOOL=ON' build/CMakeCache.txt
    grep -qx 'EXPAT_CHAR_TYPE:STRING=char' build/CMakeCache.txt
    grep -qx 'EXPAT_NS:BOOL=ON' build/CMakeCache.txt

    cmake --build build --target expat --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libexpat.a"
    test -s "$out/include/expat.h"
    test -s "$out/include/expat_external.h"

    ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
      -I"$out/include" ${./expat-runtime.c} "$out/lib/libexpat.a" \
      -o build/expat-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/expat-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    install -Dm755 build/expat-runtime "$out/bin/expat-runtime"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/expat-runtime"
    materials="$buildMaterials/share/expat-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 COPYING "$notices/expat-COPYING"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"

    cp ${./package.nix} ${./expat-runtime.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt build/install_manifest.txt \
      "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp COPYING "$materials/expat-COPYING"
    cp "$out/lib/libexpat.a" "$out/include/expat.h" "$out/include/expat_external.h" \
      "$materials/"
    cp "$out/bin/expat-runtime" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream Expat with a streamed XML parser consumer";
    license = pkgs.expat.meta.license;
  };
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "expat-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
