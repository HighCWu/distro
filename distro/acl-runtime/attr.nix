# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
}:
pkgs.stdenvNoCC.mkDerivation {
  pname = "acl-runtime-attr-${platform.wasmArch}";
  inherit (pkgs.attr) src version;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.gnumake
    pkgs.nodejs
  ];

  configurePhase = ''
    runHook preConfigure
    printf '%s\0' \
      --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
      --host=${lib.escapeShellArg platform.targetTriple} \
      --prefix=/opt/attr-runtime \
      --libdir=/opt/attr-runtime/lib \
      --includedir=/opt/attr-runtime/include \
      --disable-nls \
      --enable-static \
      --disable-shared > configure-arguments.nul
    CONFIG_SITE=${sdk-fork-automatic-poll-libc.configSite} \
      CC=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      CFLAGS=-O2 \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/opt/attr-runtime \
        --libdir=/opt/attr-runtime/lib \
        --includedir=/opt/attr-runtime/include \
        --disable-nls \
        --enable-static \
        --disable-shared
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make -j"$NIX_BUILD_CORES"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make install DESTDIR="$out"
    test -s "$out/opt/attr-runtime/lib/libattr.a"
    test -s "$out/opt/attr-runtime/include/attr/libattr.h"
    for shared_library in "$out"/opt/attr-runtime/lib/libattr.so*; do
      test ! -e "$shared_library"
    done
    for program in attr getfattr setfattr; do
      test -x "$out/opt/attr-runtime/bin/$program"
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$out/opt/attr-runtime/bin/$program" \
        ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done

    notices="$out/share/licenses/acl-runtime-attr"
    materials="$buildMaterials/share/acl-runtime-attr-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 doc/COPYING "$notices/COPYING"
    install -Dm644 doc/COPYING.LGPL "$notices/COPYING.LGPL"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses "$notices/fork-sdk"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./attr.nix} configure-arguments.nul config.log config.status Makefile \
      doc/COPYING doc/COPYING.LGPL "$materials/"
    if [ -f config.h ]; then cp config.h "$materials/"; fi
    if [ -f include/config.h ]; then cp include/config.h "$materials/include-config.h"; fi
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp -r ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses "$materials/fork-sdk-licenses"
    runHook postInstall
  '';

  meta = {
    description = "Static upstream GNU attr library and tools for ACL support";
    license = with lib.licenses; [
      gpl2Plus
      lgpl21Plus
    ];
  };
}
