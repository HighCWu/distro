# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  llvm-toolchain,
  zlib,
  vm-test,
  busybox,
  extraChecks ? { },
}:

pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libpng-runtime-${platform.wasmArch}";
  inherit (pkgs.libpng) src version;

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
  buildInputs = [ zlib ];

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
      -DPNG_SHARED=OFF \
      -DPNG_STATIC=ON \
      -DPNG_TESTS=OFF \
      -DPNG_TOOLS=OFF \
      -DPNG_HARDWARE_OPTIMIZATIONS=OFF \
      -DZLIB_USE_STATIC_LIBS=ON \
      -DZLIB_INCLUDE_DIR=${zlib}/include \
      -DZLIB_LIBRARY=${zlib}/lib/libz.a \
      -DZLIB_LIBRARY_RELEASE=${zlib}/lib/libz.a

    grep -Fqx 'CMAKE_C_COMPILER:FILEPATH=${sdk}/bin/wasm-linux-cc' build/CMakeCache.txt
    grep -Fqx 'CMAKE_AR:FILEPATH=${llvm-toolchain}/bin/llvm-ar' build/CMakeCache.txt
    grep -Fqx 'ZLIB_INCLUDE_DIR:PATH=${zlib}/include' build/CMakeCache.txt
    grep -Fqx 'ZLIB_LIBRARY_RELEASE:FILEPATH=${zlib}/lib/libz.a' build/CMakeCache.txt
    grep -qx 'PNG_SHARED:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PNG_STATIC:BOOL=ON' build/CMakeCache.txt
    grep -qx 'PNG_TESTS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PNG_TOOLS:BOOL=OFF' build/CMakeCache.txt

    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libpng16.a"
    test -s "$out/include/png.h"
    test -s "$out/include/pngconf.h"
    test -s "$out/include/pnglibconf.h"

    ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
      -I"$out/include" -I${zlib}/include \
      ${./libpng-runtime.c} "$out/lib/libpng16.a" ${zlib}/lib/libz.a -lm \
      -o build/libpng-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/libpng-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    install -Dm755 build/libpng-runtime "$out/bin/libpng-runtime"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/libpng-runtime"
    materials="$buildMaterials/share/libpng-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE "$notices/libpng-LICENSE"
    install -Dm644 ${zlib.src}/zlib.h "$notices/zlib-license-source.h"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"

    cp ${./package.nix} ${./libpng-runtime.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt build/install_manifest.txt \
      "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${zlib.src} "$materials/zlib-source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp LICENSE "$materials/libpng-LICENSE"
    cp ${zlib.src}/zlib.h "$materials/zlib-license-source.h"
    cp "$out/lib/libpng16.a" "$out/include/png.h" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libpng with a Wasm encode/decode consumer";
    license = pkgs.libpng.meta.license;
  };
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libpng-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
