# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  llvm-toolchain,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation {
  pname = "pcre2-${platform.wasmArch}";
  inherit (pkgs.pcre2) src version;
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
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_STATIC_LIBS=ON \
      -DPCRE2_BUILD_PCRE2_8=ON \
      -DPCRE2_BUILD_PCRE2_16=OFF \
      -DPCRE2_BUILD_PCRE2_32=OFF \
      -DPCRE2_SUPPORT_UNICODE=ON \
      -DPCRE2_SUPPORT_JIT=OFF \
      -DPCRE2_BUILD_PCRE2GREP=OFF \
      -DPCRE2_BUILD_TESTS=OFF \
      -DPCRE2_REBUILD_CHARTABLES=OFF

    grep -qx 'BUILD_SHARED_LIBS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'BUILD_STATIC_LIBS:BOOL=ON' build/CMakeCache.txt
    grep -qx 'PCRE2_BUILD_PCRE2_8:BOOL=ON' build/CMakeCache.txt
    grep -qx 'PCRE2_BUILD_PCRE2_16:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PCRE2_BUILD_PCRE2_32:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PCRE2_SUPPORT_UNICODE:BOOL=ON' build/CMakeCache.txt
    grep -qx 'PCRE2_SUPPORT_JIT:STRING=OFF' build/CMakeCache.txt
    grep -qx 'PCRE2_BUILD_PCRE2GREP:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PCRE2_BUILD_TESTS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'PCRE2_REBUILD_CHARTABLES:BOOL=OFF' build/CMakeCache.txt

    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libpcre2-8.a"
    test -s "$out/include/pcre2.h"
    test ! -e "$out/lib/libpcre2-8.so"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/pcre2"
    materials="$buildMaterials/share/pcre2-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 COPYING "$notices/COPYING"
    if [ -f LICENCE.md ]; then
      install -Dm644 LICENCE.md "$notices/LICENCE.md"
    elif [ -f LICENCE ]; then
      install -Dm644 LICENCE "$notices/LICENCE"
    else
      echo 'PCRE2 source is missing its license text' >&2
      exit 1
    fi
    if [ -f deps/sljit/LICENSE ]; then
      install -Dm644 deps/sljit/LICENSE "$notices/sljit-LICENSE"
    fi
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} build/CMakeCache.txt build/install_manifest.txt \
      "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp COPYING "$materials/"
    if [ -f LICENCE.md ]; then
      cp LICENCE.md "$materials/"
    else
      cp LICENCE "$materials/"
    fi
    if [ -f deps/sljit/LICENSE ]; then
      cp deps/sljit/LICENSE "$materials/sljit-LICENSE"
    fi
    cp "$out/lib/libpcre2-8.a" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream PCRE2 8-bit Unicode regular-expression library";
    license = lib.licenses.bsd3;
  };
  passthru.apk.license = "BSD-3-Clause WITH PCRE2-exception AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = extraChecks;
}
