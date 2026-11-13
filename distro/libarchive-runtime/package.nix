# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  zlib,
  acl-runtime,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libarchive-runtime-${platform.wasmArch}";
  inherit (pkgs.libarchive) src version;
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
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.cmake
    pkgs.ninja
    pkgs.nodejs
    pkgs.pkg-config
  ];
  buildInputs = [
    zlib
    acl-runtime
  ];

  buildPhase = ''
    runHook preBuild

    PKG_CONFIG_PATH=${acl-runtime}/opt/acl-runtime/lib/pkgconfig:${acl-runtime}/opt/attr-runtime/lib/pkgconfig \
    PKG_CONFIG_SYSROOT_DIR=${acl-runtime} \
    cmake -S "$src" -B build -G Ninja \
      -DCMAKE_SYSTEM_NAME:STRING=Linux \
      -DCMAKE_SYSTEM_PROCESSOR:STRING=${platform.wasmArch} \
      -DCMAKE_C_COMPILER:STRING=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      -DCMAKE_AR:FILEPATH=${llvm-toolchain}/bin/llvm-ar \
      -DCMAKE_RANLIB:FILEPATH=${llvm-toolchain}/bin/llvm-ranlib \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE:STRING=EXECUTABLE \
      -DCMAKE_C_FLAGS:STRING="-O2 -I${acl-runtime}/opt/acl-runtime/include -I${acl-runtime}/opt/attr-runtime/include" \
      -DCMAKE_EXE_LINKER_FLAGS:STRING="-L${acl-runtime}/opt/acl-runtime/lib -L${acl-runtime}/opt/attr-runtime/lib" \
      -DCMAKE_SKIP_RPATH:BOOL=ON \
      -DCMAKE_LIBRARY_PATH:STRING="${acl-runtime}/opt/acl-runtime/lib;${acl-runtime}/opt/attr-runtime/lib" \
      -DCMAKE_FIND_LIBRARY_SUFFIXES:STRING=.a \
      -DACL_LIBRARY:FILEPATH=${acl-runtime}/opt/acl-runtime/lib/libacl.a \
      -DCMAKE_INSTALL_PREFIX:PATH="$out" \
      -DCMAKE_INSTALL_LIBDIR:STRING=lib \
      -DCMAKE_INSTALL_INCLUDEDIR:STRING=include \
      -DBUILD_SHARED_LIBS=OFF \
      -DENABLE_TEST=OFF \
      -DENABLE_TAR=ON \
      -DENABLE_TAR_SHARED=OFF \
      -DENABLE_CPIO=OFF \
      -DENABLE_CAT=OFF \
      -DENABLE_UNZIP=OFF \
      -DENABLE_ZLIB=ON \
      -DZLIB_INCLUDE_DIR:PATH=${zlib}/include \
      -DZLIB_LIBRARY:FILEPATH=${zlib}/lib/libz.a \
      -DZLIB_LIBRARY_RELEASE:FILEPATH=${zlib}/lib/libz.a \
      -DZLIB_USE_STATIC_LIBS:BOOL=ON \
      -DENABLE_BZip2=OFF \
      -DENABLE_LZMA=OFF \
      -DENABLE_LZ4=OFF \
      -DENABLE_LZO=OFF \
      -DENABLE_ZSTD=OFF \
      -DENABLE_OPENSSL=OFF \
      -DENABLE_MBEDTLS=OFF \
      -DENABLE_NETTLE=OFF \
      -DENABLE_MD=OFF \
      -DENABLE_LIBB2=OFF \
      -DENABLE_LIBXML2=OFF \
      -DENABLE_BSDXML=OFF \
      -DENABLE_EXPAT=OFF \
      -DENABLE_WIN32_XMLLITE=OFF \
      -DENABLE_ICONV=OFF \
      -DENABLE_ACL=ON \
      -DENABLE_XATTR=ON \
      -DENABLE_CNG=OFF \
      -DENABLE_PCREPOSIX=OFF \
      -DENABLE_PCRE2POSIX=OFF \
      -DENABLE_LIBGCC=OFF

    grep -qx 'CMAKE_SYSTEM_NAME:STRING=Linux' build/CMakeCache.txt
    grep -Fqx 'CMAKE_SYSTEM_PROCESSOR:STRING=${platform.wasmArch}' build/CMakeCache.txt
    grep -Fqx 'CMAKE_C_COMPILER:STRING=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc' build/CMakeCache.txt
    grep -Fqx 'CMAKE_AR:FILEPATH=${llvm-toolchain}/bin/llvm-ar' build/CMakeCache.txt
    grep -Fqx 'CMAKE_RANLIB:FILEPATH=${llvm-toolchain}/bin/llvm-ranlib' build/CMakeCache.txt
    grep -qx 'CMAKE_TRY_COMPILE_TARGET_TYPE:STRING=EXECUTABLE' build/CMakeCache.txt
    grep -Fqx 'CMAKE_C_FLAGS:STRING=-O2 -I${acl-runtime}/opt/acl-runtime/include -I${acl-runtime}/opt/attr-runtime/include' build/CMakeCache.txt
    grep -Fqx 'CMAKE_EXE_LINKER_FLAGS:STRING=-L${acl-runtime}/opt/acl-runtime/lib -L${acl-runtime}/opt/attr-runtime/lib' build/CMakeCache.txt
    grep -qx 'CMAKE_SKIP_RPATH:BOOL=ON' build/CMakeCache.txt
    grep -Fqx 'CMAKE_LIBRARY_PATH:STRING=${acl-runtime}/opt/acl-runtime/lib;${acl-runtime}/opt/attr-runtime/lib' build/CMakeCache.txt
    grep -Fqx "CMAKE_INSTALL_PREFIX:PATH=$out" build/CMakeCache.txt
    grep -qx 'CMAKE_INSTALL_LIBDIR:STRING=lib' build/CMakeCache.txt
    grep -qx 'CMAKE_INSTALL_INCLUDEDIR:STRING=include' build/CMakeCache.txt
    grep -qx 'CMAKE_FIND_LIBRARY_SUFFIXES:STRING=.a' build/CMakeCache.txt
    grep -Fqx 'ZLIB_INCLUDE_DIR:PATH=${zlib}/include' build/CMakeCache.txt
    grep -Fqx 'ZLIB_LIBRARY:FILEPATH=${zlib}/lib/libz.a' build/CMakeCache.txt
    grep -Fqx 'ZLIB_LIBRARY_RELEASE:FILEPATH=${zlib}/lib/libz.a' build/CMakeCache.txt
    grep -qx 'ZLIB_USE_STATIC_LIBS:BOOL=ON' build/CMakeCache.txt
    grep -qx 'BUILD_SHARED_LIBS:BOOL=OFF' build/CMakeCache.txt
    grep -qx 'ENABLE_ZLIB:BOOL=ON' build/CMakeCache.txt
    grep -qx 'ENABLE_XATTR:BOOL=ON' build/CMakeCache.txt
    grep -qx 'ENABLE_ACL:BOOL=ON' build/CMakeCache.txt
    grep -Fqx 'ACL_LIBRARY:FILEPATH=${acl-runtime}/opt/acl-runtime/lib/libacl.a' \
      build/CMakeCache.txt
    grep -qx 'HAVE_LIBACL:INTERNAL=1' build/CMakeCache.txt
    grep -qx 'HAVE_LIBATTR:INTERNAL=1' build/CMakeCache.txt
    grep -qx 'HAVE_ACL_LIBACL_H:INTERNAL=1' build/CMakeCache.txt
    grep -qx 'HAVE_ACL_GET_PERM:INTERNAL=1' build/CMakeCache.txt
    grep -Fqx '#define HAVE_STDIO_H 1' build/config.h
    grep -Fqx '#define ARCHIVE_ACL_LIBACL 1' build/config.h

    cmake --build build --target archive_static bsdtar --parallel "$NIX_BUILD_CORES"
    cmake --install build
    test -s "$out/lib/libarchive.a"
    test -s "$out/include/archive.h"
    test -x "$out/bin/bsdtar"

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$out/bin/bsdtar" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    ${sdk}/bin/wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror \
      ${./xattr-helper.c} -o build/libarchive-xattr-helper
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/libarchive-xattr-helper ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    install -Dm755 build/libarchive-xattr-helper "$out/bin/libarchive-xattr-helper"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/libarchive-runtime"
    materials="$buildMaterials/share/libarchive-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 "$src/COPYING" "$notices/libarchive-COPYING"
    install -Dm644 ${zlib.src}/zlib.h "$notices/zlib-license-source.h"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$notices/automatic-fork-sdk"
    cp -r ${acl-runtime}/share/licenses/acl-runtime "$notices/acl-runtime"

    cp ${./package.nix} ${./runtime-test.sh} \
      ${./xattr-helper.c} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/CMakeCache.txt build/install_manifest.txt \
      "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${zlib.src} "$materials/zlib-source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/automatic-fork-sdk"
    ln -s ${acl-runtime} "$materials/acl-runtime"
    ln -s ${acl-runtime.buildMaterials} "$materials/acl-runtime-build-materials"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp -r ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$materials/automatic-fork-sdk-licenses"
    cp "$src/COPYING" "$materials/libarchive-COPYING"
    cp ${zlib.src}/zlib.h "$materials/zlib-license-source.h"
    cp "$out/bin/bsdtar" "$out/lib/libarchive.a" "$materials/"
    cp "$out/bin/libarchive-xattr-helper" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream libarchive and bsdtar with ACL and external filter support";
    license = [
      lib.licenses.bsd2
      lib.licenses.zlib
      lib.licenses.mit
      lib.licenses.lgpl21Plus
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "BSD-2-Clause AND Zlib AND LGPL-2.1-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks =
    let
      xattrDisk =
        pkgs.runCommand "libarchive-xattr-ext4-disk"
          {
            nativeBuildInputs = [
              pkgs.coreutils
              pkgs.e2fsprogs
            ];
          }
          ''
            truncate -s 8M "$out"
            mkfs.ext4 -F -q "$out"
          '';
    in
    {
      runtime = vm-test.rawInitramfsTest {
        name = "libarchive-runtime-${platform.wasmArch}";
        init = ./runtime-test.sh;
        cpus = 2;
        disks = [ xattrDisk ];
        snapshotFirstDisk = true;
        contents = [
          busybox
          acl-runtime
          finalAttrs.finalPackage
        ];
      };
    }
    // extraChecks;
})
