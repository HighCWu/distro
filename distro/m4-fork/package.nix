# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "m4-fork";
  inherit (pkgs.m4) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;

  nativeBuildInputs = [
    sdk
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.gawk
    pkgs.gnumake
    pkgs.nodejs
    pkgs.perl
    pkgs.texinfo
  ];

  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-automatic-poll-libc.configSite} \
      CC=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      NM=${llvm-toolchain}/bin/llvm-nm \
      LD=${llvm-toolchain}/bin/wasm-ld \
      CFLAGS=-O2 \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/opt/m4-fork \
        --disable-nls
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make -j"$NIX_BUILD_CORES"

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      src/m4 ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make install DESTDIR="$out"
    mkdir -p "$out/bin"
    ln -s ../opt/m4-fork/bin/m4 "$out/bin/m4-fork"

    notices="$out/share/licenses/m4-fork"
    materials="$buildMaterials/share/m4-fork-materials"
    mkdir -p "$notices" "$materials"
    for notice in \
      COPYING \
      COPYINGv3 \
      COPYING.LESSER \
      COPYING.LIB \
      lib/COPYING \
      lib/COPYING.LESSER \
      lib/COPYING.LIB; do
      if [ -f "$notice" ]; then
        install -Dm644 "$notice" "$notices/$notice"
      fi
    done
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$notices/fork-sdk"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT "$notices/LLVM-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT "$notices/Clang-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT "$notices/LLD-LICENSE.TXT"

    cp Makefile config.log config.status configure-arguments.nul \
      ${./package.nix} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    printf 'source=GNU M4\nversion=%s\n' "$version" > "$materials/source-identity.txt"
    ln -s "$src" "$materials/source"
    sha256sum "$src" > "$materials/source.sha256"
    if [ -f config.h ]; then
      cp config.h "$materials/config.h"
    fi
    if [ -f lib/config.h ]; then
      cp lib/config.h "$materials/lib-config.h"
    fi
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  preConfigure = ''
    printf '%s\0' \
      --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
      --host=${lib.escapeShellArg platform.targetTriple} \
      --prefix=/opt/m4-fork \
      --disable-nls > configure-arguments.nul
  '';

  meta = {
    description = "Unmodified GNU M4 using the automatic fork and polling libc SDK";
    outputsToInstall = [ "out" ];
    mainProgram = "m4-fork";
    license = with lib.licenses; [
      gpl3Plus
      mit
    ];
    platforms = lib.platforms.unix;
  };

  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "m4-fork-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 2;
    };
  }
  // extraChecks;
})
