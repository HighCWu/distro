# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  llvm-toolchain,
  libgit2 ? pkgs.libgit2,
  zlib,
  openssl,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libgit2-runtime-${platform.wasmArch}";
  inherit (libgit2) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  setOutputFlags = false;
  moveToDev = false;
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
  buildInputs = [
    zlib
    openssl
  ];

  buildPhase = ''
    runHook preBuild

    source_tree="$(pwd -P)"
    test -f "$source_tree/CMakeLists.txt"
    test -f "$source_tree/COPYING"

    cmake -S "$source_tree" -B build -G Ninja \
      -DCMAKE_TOOLCHAIN_FILE=${sdk}/share/cmake/linux-wasm.cmake \
      -DCMAKE_AR=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_SYSTEM_PROCESSOR=${platform.wasmArch} \
      -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
      '-DCMAKE_C_FLAGS=-DNO_MMAP -pthread' \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/libgit2-runtime \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_TESTS=OFF \
      -DBUILD_CLI=OFF \
      -DBUILD_EXAMPLES=OFF \
      -DBUILD_FUZZERS=OFF \
      -DUSE_THREADS=ON \
      -DUSE_SSH=OFF \
      -DUSE_HTTPS=OpenSSL \
      -DUSE_HTTP_PARSER=builtin \
      -DREGEX_BACKEND=builtin \
      -DUSE_BUNDLED_ZLIB=OFF \
      -DUSE_NTLMCLIENT=OFF \
      -DUSE_SHA1=CollisionDetection \
      -DUSE_SHA256=OpenSSL \
      -DZLIB_INCLUDE_DIR=${zlib}/include \
      -DZLIB_LIBRARY=${zlib}/lib/libz.a \
      -DZLIB_LIBRARY_RELEASE=${zlib}/lib/libz.a \
      -DZLIB_LIBRARY_DEBUG=${zlib}/lib/libz.a \
      -DOPENSSL_ROOT_DIR=${openssl} \
      -DOPENSSL_USE_STATIC_LIBS=TRUE \
      -DOPENSSL_INCLUDE_DIR=${openssl}/include \
      -DOPENSSL_SSL_LIBRARY=${openssl}/lib/libssl.a \
      -DOPENSSL_CRYPTO_LIBRARY=${openssl}/lib/libcrypto.a

    grep -qx 'CMAKE_C_FLAGS:STRING=-DNO_MMAP -pthread' build/CMakeCache.txt
    grep -qx 'BUILD_SHARED_LIBS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'BUILD_TESTS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'BUILD_CLI:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'USE_THREADS:BOOL=ON' build/CMakeCache.txt
    grep -qx 'USE_SSH:STRING=OFF' build/CMakeCache.txt
    grep -qx 'USE_HTTPS:STRING=OpenSSL' build/CMakeCache.txt
    grep -qx 'USE_HTTP_PARSER:STRING=builtin' build/CMakeCache.txt
    grep -qx 'REGEX_BACKEND:STRING=builtin' build/CMakeCache.txt
    grep -qx 'USE_BUNDLED_ZLIB:STRING=OFF' build/CMakeCache.txt
    grep -qx 'USE_SHA1:STRING=CollisionDetection' build/CMakeCache.txt
    grep -qx 'USE_SHA256:STRING=OpenSSL' build/CMakeCache.txt
    grep -F -- '${zlib}/include' build/CMakeCache.txt
    grep -F -- '${zlib}/lib/libz.a' build/CMakeCache.txt
    grep -F -- '${openssl}/lib/libssl.a' build/CMakeCache.txt
    grep -F -- '${openssl}/lib/libcrypto.a' build/CMakeCache.txt
    grep -qx '#define GIT_THREADS 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_OPENSSL 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_REGEX_BUILTIN 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_HTTPPARSER_BUILTIN 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_COMPRESSION_ZLIB 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_SHA1_COLLISIONDETECT 1' build/gen_headers/git2_features.h
    grep -qx '#define GIT_SHA256_OPENSSL 1' build/gen_headers/git2_features.h
    if grep -q '^#define GIT_SSH 1$' build/gen_headers/git2_features.h; then
      echo "libgit2 enabled an SSH transport despite USE_SSH=OFF" >&2
      exit 1
    fi

    cmake --build build --parallel "$NIX_BUILD_CORES"
    cmake --install build --prefix "$out/opt/libgit2-runtime"
    test -s "$out/opt/libgit2-runtime/lib/libgit2.a"
    test -s "$out/opt/libgit2-runtime/include/git2.h"
    test -n "$(${llvm-toolchain}/bin/llvm-ar t "$out/opt/libgit2-runtime/lib/libgit2.a")"

    mkdir -p build/runtime
    ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
      -I"$out/opt/libgit2-runtime/include" \
      ${./runtime.c} \
      "$out/opt/libgit2-runtime/lib/libgit2.a" \
      ${zlib}/lib/libz.a \
      ${openssl}/lib/libssl.a \
      ${openssl}/lib/libcrypto.a \
      -pthread \
      -o build/runtime/libgit2-runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/runtime/libgit2-runtime.wasm ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    source_tree="$(pwd -P)"
    test -f "$source_tree/COPYING"
    test -f "$source_tree/deps/pcre/LICENCE"
    test -f "$source_tree/deps/llhttp/LICENSE-MIT"

    install -Dm755 build/runtime/libgit2-runtime.wasm \
      "$out/libexec/libgit2-runtime/runtime.wasm"

    notices="$out/share/licenses/libgit2-runtime"
    materials="$buildMaterials/share/libgit2-runtime-materials"
    mkdir -p "$notices" "$materials/licenses/dependencies"
    install -Dm644 "$source_tree/COPYING" "$notices/libgit2-COPYING"
    install -Dm644 ${zlib.src}/LICENSE "$notices/zlib-LICENSE"
    install -Dm644 ${openssl.src}/LICENSE.txt "$notices/openssl-LICENSE.txt"
    install -Dm644 "$source_tree/deps/pcre/LICENCE" "$notices/pcre-LICENCE"
    install -Dm644 "$source_tree/deps/llhttp/LICENSE-MIT" "$notices/llhttp-LICENSE-MIT"
    install -Dm644 ${./SHA1DC-LICENSE.txt} "$notices/SHA1DC-LICENSE.txt"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"

    cp ${./package.nix} ${./runtime.c} \
      build/CMakeCache.txt build/compile_commands.json build/install_manifest.txt \
      build/gen_headers/git2_features.h \
      "$materials/"
    install -Dm644 "$source_tree/COPYING" "$materials/licenses/dependencies/libgit2-COPYING"
    install -Dm644 ${zlib.src}/LICENSE "$materials/licenses/dependencies/zlib-LICENSE"
    install -Dm644 ${openssl.src}/LICENSE.txt \
      "$materials/licenses/dependencies/openssl-LICENSE.txt"
    install -Dm644 "$source_tree/deps/pcre/LICENCE" \
      "$materials/licenses/dependencies/pcre-LICENCE"
    install -Dm644 "$source_tree/deps/llhttp/LICENSE-MIT" \
      "$materials/licenses/dependencies/llhttp-LICENSE-MIT"
    install -Dm644 ${./SHA1DC-LICENSE.txt} \
      "$materials/licenses/dependencies/SHA1DC-LICENSE.txt"
    install -Dm644 ${../sdk/LICENSE.MIT} "$materials/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"

    cp "$out/opt/libgit2-runtime/lib/libgit2.a" "$materials/libgit2.a"
    cp "$out/libexec/libgit2-runtime/runtime.wasm" "$materials/libgit2-runtime.wasm"
    cat > "$materials/build-config.txt" <<'EOF'
    source: libgit2 ${libgit2.version} from the locked Nixpkgs libgit2.src
    library: static libgit2.a; CMake USE_THREADS=ON; HTTPS=OpenSSL
    optional backends: SSH=OFF; HTTP parser=upstream bundled llhttp; regex=upstream bundled PCRE
    file mapping: source NO_MMAP selected with -DNO_MMAP; read-only mappings use pread
    runtime: local repository, real commit/index/tree/blob, branch checkout/conflict, pack/index read
    linked target libraries: zlib=${zlib.version}; OpenSSL=${openssl.version}
    EOF
    ln -s "$src" "$materials/source"
    ln -s ${zlib.src} "$materials/zlib-source"
    ln -s ${openssl.src} "$materials/openssl-source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    cp ${../zlib/package.nix} "$materials/zlib-source-package.nix"
    cp ${../openssl/package.nix} "$materials/openssl-source-package.nix"
    cp ${../sdk/package.nix} "$materials/standard-sdk-package.nix"

    runHook postInstall
  '';

  meta = {
    description = "Static POSIX-threaded libgit2 with OpenSSL HTTPS and a runtime C consumer";
    homepage = "https://libgit2.org/";
    license = [
      lib.licenses.gpl2Only
      lib.licenses.zlib
      lib.licenses.bsd3
      lib.licenses.asl20
      lib.licenses.mit
    ];
  };

  # libgit2's full COPYING, including its project-specific linking exception,
  # is retained with the output and build materials.
  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-2.0-only AND BSD-3-Clause AND MIT AND Zlib AND Apache-2.0 AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libgit2-runtime-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/libexec/libgit2-runtime/runtime.wasm";
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 2;
    };
  }
  // extraChecks;
})
