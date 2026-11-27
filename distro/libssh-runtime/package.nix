# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  openssl,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libssh-runtime-${platform.wasmArch}";
  inherit (pkgs.libssh) src version;
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

  # WITH_EXEC controls local shell/proxy subprocess helpers, not SSH channel
  # exec requests. Disabling it keeps the library free of fork() paths.
  buildPhase = ''
    runHook preBuild

    cmake -S . -B build -G Ninja \
      -DCMAKE_SYSTEM_NAME=Linux \
      -DCMAKE_SYSTEM_PROCESSOR=${platform.wasmArch} \
      -DCMAKE_C_COMPILER=${sdk}/bin/wasm-linux-cc \
      -DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_C_FLAGS=-pthread \
      -DHAVE_MEMSET_EXPLICIT=OFF \
      -DHAVE_MEMSET_S=OFF \
      -DCMAKE_THREAD_PREFER_PTHREADS=ON \
      -DTHREADS_PREFER_PTHREAD_FLAG=ON \
      -DCMAKE_INSTALL_PREFIX="$out" \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=OFF \
      -DWITH_SERVER=ON \
      -DWITH_GSSAPI=OFF \
      -DWITH_ZLIB=OFF \
      -DWITH_SFTP=ON \
      -DWITH_EXAMPLES=OFF \
      -DWITH_EXEC=OFF \
      -DWITH_PCAP=OFF \
      -DWITH_NACL=OFF \
      -DWITH_GCRYPT=OFF \
      -DWITH_MBEDTLS=OFF \
      -DWITH_SYMBOL_VERSIONING=OFF \
      -DUNIT_TESTING=OFF \
      -DCLIENT_TESTING=OFF \
      -DSERVER_TESTING=OFF \
      -DGSSAPI_TESTING=OFF \
      -DWITH_BENCHMARKS=OFF \
      -DOPENSSL_ROOT_DIR=${openssl} \
      -DOPENSSL_INCLUDE_DIR=${openssl}/include \
      -DOPENSSL_SSL_LIBRARY=${openssl}/lib/libssl.a \
      -DOPENSSL_CRYPTO_LIBRARY=${openssl}/lib/libcrypto.a \
      -DOPENSSL_USE_STATIC_LIBS=ON
    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build

    test -s "$out/include/libssh/libssh.h"
    test -s "$out/include/libssh/server.h"
    test -s "$out/include/libssh/sftp.h"
    test -s "$out/lib/libssh.a"

    ${sdk}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I"$out/include" ${./runtime.c} \
      "$out/lib/libssh.a" ${openssl}/lib/libssl.a ${openssl}/lib/libcrypto.a \
      -pthread -o libssh-runtime.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      libssh-runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 libssh-runtime.wasm "$out/bin/libssh-runtime"

    notices="$out/share/licenses/libssh-runtime"
    materials="$buildMaterials/share/libssh-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 COPYING "$notices/libssh-COPYING"
    install -Dm644 BSD "$notices/libssh-BSD"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${openssl}/share/licenses/openssl "$notices/openssl"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp ${./package.nix} ${./runtime.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt "$materials/"
    ln -s "$src" "$materials/source.tar.xz"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${openssl.src} "$materials/openssl-source"
    cp ${../openssl/package.nix} "$materials/openssl-source-package.nix"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libssh client, server, and SFTP runtime check";
    license = lib.licenses.lgpl21Plus;
  };
  passthru.apk.license = "LGPL-2.1-or-later AND BSD-3-Clause AND MIT AND Apache-2.0 AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libssh-runtime-${platform.wasmArch}";
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
