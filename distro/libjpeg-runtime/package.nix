# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  llvm-toolchain,
  vm-test,
  busybox,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libjpeg-runtime-${platform.wasmArch}";
  inherit (pkgs.libjpeg_turbo) src version;
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
      -DCMAKE_C_FLAGS_RELEASE=-O2 \
      -DCMAKE_INSTALL_PREFIX="$out" \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DENABLE_SHARED=OFF \
      -DENABLE_STATIC=ON \
      -DWITH_SIMD=OFF \
      -DWITH_TURBOJPEG=OFF \
      -DWITH_TOOLS=OFF \
      -DWITH_TESTS=OFF \
      -DWITH_FUZZ=OFF \
      -DWITH_JAVA=OFF

    grep -qx 'ENABLE_SHARED:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'ENABLE_STATIC:BOOL=ON' build/CMakeCache.txt
    grep -qx 'WITH_SIMD:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'WITH_TURBOJPEG:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'WITH_TOOLS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'WITH_TESTS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'WITH_FUZZ:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'WITH_JAVA:BOOL=OFF' build/CMakeCache.txt

    cmake --build build --target jpeg-static --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libjpeg.a"
    test -s "$out/include/jpeglib.h"
    test -s "$out/include/jconfig.h"
    test ! -e "$out/lib/libjpeg.so"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/libjpeg-runtime"
    materials="$buildMaterials/share/libjpeg-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE.md "$notices/LICENSE.md"
    install -Dm644 README.ijg "$notices/README.ijg"
    install -Dm644 ${./NOTICE} "$notices/NOTICE"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"

    cp ${./package.nix} ${./jpeg-roundtrip.c} ${./runtime-test.sh} ${./NOTICE} \
      build/CMakeCache.txt build/install_manifest.txt \
      "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp LICENSE.md README.ijg "$materials/"
    cp "$out/lib/libjpeg.a" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream JPEG API library with portable C implementation";
    homepage = "https://libjpeg-turbo.org/";
    license = pkgs.libjpeg_turbo.meta.license;
    platforms = lib.platforms.all;
  };

  passthru.checks = {
    runtime =
      let
        roundtrip = pkgs.stdenvNoCC.mkDerivation {
          pname = "libjpeg-roundtrip-${platform.wasmArch}";
          version = "1";
          dontUnpack = true;
          dontConfigure = true;
          dontFixup = true;
          nativeBuildInputs = [
            sdk
            pkgs.nodejs
          ];

          buildPhase = ''
            runHook preBuild
            ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
              -I${finalAttrs.finalPackage}/include \
              ${./jpeg-roundtrip.c} \
              ${finalAttrs.finalPackage}/lib/libjpeg.a \
              -lm \
              -o jpeg-roundtrip
            node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
              jpeg-roundtrip ${toString platform.addressBits} \
              ${toString platform.maximumMemoryBytes}
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            install -Dm755 jpeg-roundtrip "$out/bin/jpeg-roundtrip"
            runHook postInstall
          '';
        };
      in
      vm-test.installedTest {
        name = "libjpeg-runtime-${platform.wasmArch}";
        init = ./runtime-test.sh;
        contents = [
          busybox
          roundtrip
        ];
      };
  };
})
