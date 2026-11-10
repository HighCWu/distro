# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libuv-runtime-${platform.wasmArch}";
  inherit (pkgs.libuv) src version;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontConfigure = true;
  dontCheck = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-automatic
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.patch
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild

    # Keep the pinned source immutable and apply the Wasm pthread ABI shim to
    # a local copy before building libuv.
    mkdir libuv-source
    cp -r "$src"/. libuv-source/
    chmod -R u+w libuv-source
    patch -d libuv-source -p1 < ${./wasm-thread-entry.patch}

    # Use the automatic fork profile for the main consumer. uv_spawn runs in
    # stage one before libuv's filesystem worker pool has started.
    cmake -S libuv-source -B build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=${platform.wasmArch} \
      -DCMAKE_C_COMPILER=${sdk-fork-automatic}/bin/wasm-linux-fork-cc \
      -DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DCMAKE_INSTALL_PREFIX="$out" \
      -DBUILD_TESTING=OFF \
      -DLIBUV_BUILD_TESTS=OFF \
      -DLIBUV_BUILD_SHARED=OFF \
      -DLIBUV_BUILD_BENCH=OFF
    cmake --build build --target uv_a --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libuv.a"
    test -s "$out/include/uv.h"

    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./helper.c} -o libuv-helper.wasm
    ${sdk-fork-automatic}/bin/wasm-linux-fork-cc -O2 -pthread -Wall -Wextra -Werror \
      -I"$out/include" ${./runtime.c} "$out/lib/libuv.a" -pthread -ldl -lrt \
      -o libuv-runtime.wasm

    for program in libuv-runtime.wasm libuv-helper.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 libuv-runtime.wasm "$out/bin/libuv-runtime"
    install -Dm755 libuv-helper.wasm "$out/bin/libuv-helper"

    notices="$out/share/licenses/libuv-runtime"
    materials="$buildMaterials/share/libuv-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 "$src/LICENSE" "$notices/libuv-LICENSE"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/FORK-SDK-MIT.txt"
    install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/Binaryen-LICENSE \
      "$notices/Binaryen-LICENSE"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./helper.c} ${./runtime.c} ${./runtime-test.sh} \
      ${./wasm-thread-entry.patch} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic.buildMaterials} "$materials/automatic-fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libuv runtime checks for process, filesystem, and pipe APIs";
    license = lib.licenses.mit;
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libuv-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 2;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
