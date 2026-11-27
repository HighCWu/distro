# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  llvm-toolchain,
  openssl,
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
  dontConfigure = true;
  dontCheck = true;
  dontFixup = true;

  nativeBuildInputs = [
    sdk
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.nodejs
    pkgs.openssl
  ];

  buildPhase = ''
    runHook preBuild

    cmake -S . -B build -G Ninja \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
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
      -DEVENT__DISABLE_OPENSSL=OFF \
      -DOPENSSL_USE_STATIC_LIBS=TRUE \
      -DOPENSSL_ROOT_DIR=${openssl} \
      -DOPENSSL_INCLUDE_DIR=${openssl}/include \
      -DOPENSSL_SSL_LIBRARY=${openssl}/lib/libssl.a \
      -DOPENSSL_CRYPTO_LIBRARY=${openssl}/lib/libcrypto.a \
      -DEVENT__DISABLE_THREAD_SUPPORT=OFF
    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build

    test -s "$out/include/event2/event.h"
    test -s "$out/lib/libevent.a"
    test -s "$out/lib/libevent_core.a"
    test -s "$out/lib/libevent_extra.a"
    test -s "$out/lib/libevent_pthreads.a"
    test -s "$out/lib/libevent_openssl.a"
    test -s "$out/include/event2/bufferevent_ssl.h"

    ${sdk}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I"$out/include" ${./runtime.c} \
      -Wl,--start-group "$out/lib/libevent_pthreads.a" "$out/lib/libevent_core.a" \
      -Wl,--end-group -pthread -o libevent-runtime.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      libevent-runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    ${sdk}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I"$out/include" -I"${openssl}/include" ${./runtime-tls.c} \
      -Wl,--start-group "$out/lib/libevent_openssl.a" "$out/lib/libevent_pthreads.a" \
      "$out/lib/libevent_core.a" "${openssl}/lib/libssl.a" "${openssl}/lib/libcrypto.a" \
      -Wl,--end-group -pthread -o libevent-runtime-tls.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      libevent-runtime-tls.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 libevent-runtime.wasm "$out/bin/libevent-runtime"
    install -Dm755 libevent-runtime-tls.wasm "$out/bin/libevent-runtime-tls"
    mkdir -p "$out/share/libevent-runtime/tls-test"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -subj '/CN=localhost' \
      -not_before 20261110035228Z \
      -not_after 20361107035228Z \
      -addext 'subjectAltName=DNS:localhost' \
      -addext 'basicConstraints=critical,CA:TRUE' \
      -addext 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign' \
      -addext 'extendedKeyUsage=serverAuth' \
      -keyout "$out/share/libevent-runtime/tls-test/localhost-test-key.pem" \
      -out "$out/share/libevent-runtime/tls-test/localhost-test-cert.pem"
    chmod 0644 \
      "$out/share/libevent-runtime/tls-test/localhost-test-cert.pem" \
      "$out/share/libevent-runtime/tls-test/localhost-test-key.pem"

    notices="$out/share/licenses/libevent-runtime"
    materials="$buildMaterials/share/libevent-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE "$notices/libevent-LICENSE"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./runtime.c} ${./runtime-test.sh} ${./runtime-tls.c} \
      ${./runtime-tls-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libevent runtime and OpenSSL bufferevent TLS check";
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
    tls-runtime = vm-test.rawInitramfsTest {
      name = "libevent-tls-runtime-${platform.wasmArch}";
      init = ./runtime-tls-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
