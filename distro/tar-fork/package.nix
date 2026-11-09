# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  tar,
  sdk,
  sdk-fork-continuation,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "tar-standard-fork";
  inherit (tar) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-continuation
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.bison
    pkgs.gawk
    pkgs.perl
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-continuation.configSite} \
      CC=wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=llvm-ar RANLIB=llvm-ranlib CFLAGS=-O2 \
      ./configure --build=${pkgs.stdenv.buildPlatform.config} \
      --host=${platform.targetTriple} --prefix=/ --disable-nls
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmp ${tar.src}/lib/rtapelib.c lib/rtapelib.c
    cmp ${tar.src}/src/common.h src/common.h
    cmp ${tar.src}/src/misc.c src/misc.c
    cmp ${tar.src}/src/system.c src/system.c

    # Each recursive Automake directory builds its own BUILT_SOURCES before
    # its archive/program targets. Avoid the unrelated documentation/tests.
    make -C gnu -j$NIX_BUILD_CORES
    make -C lib -j$NIX_BUILD_CORES
    make -C src -j$NIX_BUILD_CORES tar

    sha256sum lib/rtapelib.c src/common.h src/misc.c src/system.c > program-source.sha256
    wasm-linux-fork-finalize src/tar tar.wasm
    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror ${./helper.c} -o tar-fork-helper.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      tar.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    cmp ${tar.src}/lib/rtapelib.c lib/rtapelib.c
    cmp ${tar.src}/src/common.h src/common.h
    cmp ${tar.src}/src/misc.c src/misc.c
    cmp ${tar.src}/src/system.c src/system.c
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 tar.wasm $out/bin/tar
    install -Dm755 tar-fork-helper.wasm $out/bin/tar-fork-helper

    notices=$out/share/licenses/tar-fork
    materials=$buildMaterials/share/tar-fork-materials
    mkdir -p "$notices" "$materials"
    cp COPYING "$notices/"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    cp config.h config.log program-source.sha256 ${./package.nix} ${./runtime-test.sh} ${./helper.c} \
      "$materials/"
    ln -s $src "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/sdk"
    ln -s ${sdk-fork-continuation.buildMaterials} "$materials/fork-sdk"
    runHook postInstall
  '';
  meta = {
    description = "Unpatched GNU tar using the opt-in static C fork profile";
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    replaces = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "tar-standard-fork-${platform.wasmArch}";
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
