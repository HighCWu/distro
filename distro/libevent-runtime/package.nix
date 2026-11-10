# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libevent-runtime-${platform.wasmArch}";
  inherit (pkgs.libevent) src version;
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
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild

    cmake -S "$src" -B build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=${platform.wasmArch} \
      -DCMAKE_C_COMPILER=${sdk}/bin/wasm-linux-cc \
      -DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_C_FLAGS=-pthread \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DCMAKE_INSTALL_PREFIX="$out" \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=OFF \
      -DEVENT__LIBRARY_TYPE=STATIC \
      -DEVENT__DISABLE_TESTS=ON \
      -DEVENT__DISABLE_SAMPLES=ON \
      -DEVENT__DISABLE_BENCHMARK=ON \
      -DEVENT__DISABLE_OPENSSL=ON \
      -DEVENT__DISABLE_THREAD_SUPPORT=OFF
    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build

    test -s "$out/include/event2/event.h"
    test -s "$out/lib/libevent.a"
    test -s "$out/lib/libevent_core.a"
    test -s "$out/lib/libevent_extra.a"
    test -s "$out/lib/libevent_pthreads.a"

    ${sdk}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I"$out/include" ${./runtime.c} \
      -Wl,--start-group "$out/lib/libevent_pthreads.a" "$out/lib/libevent_core.a" \
      -Wl,--end-group -pthread -o libevent-runtime.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      libevent-runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 libevent-runtime.wasm "$out/bin/libevent-runtime"

    notices="$out/share/licenses/libevent-runtime"
    materials="$buildMaterials/share/libevent-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 "$src/LICENSE" "$notices/libevent-LICENSE"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./runtime.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libevent epoll, signal, timer, and TCP runtime check";
    license = lib.licenses.bsd3;
  };
  passthru.apk.license = "BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libevent-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
