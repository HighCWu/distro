# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
let
  attr = import ./attr.nix {
    inherit
      pkgs
      lib
      platform
      sdk
      sdk-fork-automatic-poll-libc
      llvm-toolchain
      ;
  };
  ext4Disk =
    pkgs.runCommand "acl-runtime-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O ext_attr,^has_journal -m 0 "$out"
      '';
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "acl-runtime-${platform.wasmArch}";
  inherit (pkgs.acl) src version;
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
    pkgs.pkg-config
    pkgs.nodejs
  ];
  buildInputs = [ attr ];
  doCheck = false;

  configurePhase = ''
    runHook preConfigure
    printf '%s\0' \
      --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
      --host=${lib.escapeShellArg platform.targetTriple} \
      --prefix=/opt/acl-runtime \
      --libdir=/opt/acl-runtime/lib \
      --includedir=/opt/acl-runtime/include \
      --bindir=/opt/acl-runtime/bin \
      --disable-nls \
      --enable-static \
      --disable-shared > configure-arguments.nul
    PKG_CONFIG_PATH=${attr}/opt/attr-runtime/lib/pkgconfig \
    PKG_CONFIG_SYSROOT_DIR=${attr} \
    CONFIG_SITE=${sdk-fork-automatic-poll-libc.configSite} \
      CC=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      CPPFLAGS=-I${attr}/opt/attr-runtime/include \
      LDFLAGS=-L${attr}/opt/attr-runtime/lib \
      LIBS=-lattr \
      CFLAGS=-O2 \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/opt/acl-runtime \
        --libdir=/opt/acl-runtime/lib \
        --includedir=/opt/acl-runtime/include \
        --bindir=/opt/acl-runtime/bin \
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
    test -s "$out/opt/acl-runtime/lib/libacl.a"
    test -s "$out/opt/acl-runtime/include/sys/acl.h"
    for shared_library in "$out"/opt/acl-runtime/lib/libacl.so*; do
      test ! -e "$shared_library"
    done
    test -x "$out/opt/acl-runtime/bin/getfacl"
    test -x "$out/opt/acl-runtime/bin/setfacl"
    test -x "$out/opt/acl-runtime/bin/chacl"

    mkdir -p "$out/opt/acl-runtime/bin"
    ${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      -O2 -Wall -Wextra -Werror \
      -I"$out/opt/acl-runtime/include" \
      -I${attr}/opt/attr-runtime/include \
      ${./runtime.c} \
      "$out/opt/acl-runtime/lib/libacl.a" \
      "${attr}/opt/attr-runtime/lib/libattr.a" \
      -o "$out/opt/acl-runtime/bin/acl-runtime"

    for program in getfacl setfacl chacl acl-runtime; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$out/opt/acl-runtime/bin/$program" \
        ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done

    mkdir -p "$out/opt/attr-runtime"
    cp -r ${attr}/opt/attr-runtime/include "$out/opt/attr-runtime/"
    cp -r ${attr}/opt/attr-runtime/lib "$out/opt/attr-runtime/"

    notices="$out/share/licenses/acl-runtime"
    materials="$buildMaterials/share/acl-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 doc/COPYING "$notices/acl-COPYING"
    install -Dm644 doc/COPYING.LGPL "$notices/acl-COPYING.LGPL"
    cp -rL ${attr}/share/licenses/acl-runtime-attr "$notices/attr"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses "$notices/fork-sdk"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./attr.nix} ${./runtime.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      config.log config.status Makefile configure-arguments.nul \
      "$materials/"
    if [ -f config.h ]; then cp config.h "$materials/"; fi
    if [ -f include/config.h ]; then cp include/config.h "$materials/include-config.h"; fi
    cp doc/COPYING doc/COPYING.LGPL "$materials/"
    ln -s "$src" "$materials/acl-source"
    ln -s ${attr.src} "$materials/attr-source"
    ln -s ${attr.buildMaterials} "$materials/attr-build-materials"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses "$materials/fork-sdk-licenses"
    cp "$out/opt/acl-runtime/lib/libacl.a" "$materials/"
    cp "$out/opt/attr-runtime/lib/libattr.a" "$materials/"
    cp "$out/opt/acl-runtime/bin/acl-runtime" "$materials/"
    runHook postInstall
  '';

  meta = {
    description = "Static GNU ACL library and POSIX ACL runtime test on ext4";
    license = with lib.licenses; [
      gpl2Plus
      lgpl21Plus
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-2.0-or-later AND LGPL-2.1-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "acl-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 2;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ ext4Disk ];
      snapshotFirstDisk = true;
    };
  }
  // extraChecks;
})
