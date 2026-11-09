# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  findutils,
  sdk,
  sdk-fork-automatic,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "findutils-standard-fork";
  inherit (findutils) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-automatic
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.perl
    pkgs.gawk
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-automatic.configSite} CC=wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc AR=llvm-ar RANLIB=llvm-ranlib CFLAGS=-O2 \
      ./configure --build=${pkgs.stdenv.buildPlatform.config} --host=${platform.targetTriple} \
      --prefix=/ --disable-nls
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmp ${findutils.src}/find/exec.c find/exec.c
    cmp ${findutils.src}/xargs/xargs.c xargs/xargs.c
    make -j$NIX_BUILD_CORES -C gl
    make -j$NIX_BUILD_CORES -C lib
    make -j$NIX_BUILD_CORES -C find
    make -j$NIX_BUILD_CORES -C xargs
    cmp ${findutils.src}/find/exec.c find/exec.c
    cmp ${findutils.src}/xargs/xargs.c xargs/xargs.c
    sha256sum find/exec.c xargs/xargs.c > program-source.sha256
    cp find/find find.wasm
    cp xargs/xargs xargs.wasm
    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror ${./helper.c} -o find-fork-helper
    for binary in find.wasm xargs.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 find.wasm $out/bin/find
    install -Dm755 xargs.wasm $out/bin/xargs
    install -Dm755 find-fork-helper $out/bin/find-fork-helper
    notices=$out/share/licenses/findutils-fork
    mkdir -p "$notices" $buildMaterials/share/findutils-fork-materials
    cp COPYING "$notices/"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    cp config.h config.log program-source.sha256 ${./package.nix} ${./helper.c} \
      ${./runtime-test.sh} $buildMaterials/share/findutils-fork-materials/
    ln -s $src $buildMaterials/share/findutils-fork-materials/source
    ln -s ${sdk-fork-automatic.buildMaterials} $buildMaterials/share/findutils-fork-materials/sdk
    ln -s ${sdk.buildMaterials} $buildMaterials/share/findutils-fork-materials/helper-sdk
    runHook postInstall
  '';
  meta = {
    description = "Unpatched GNU find and xargs using the opt-in static C fork profile";
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
    ];
  };
  passthru.apk.replaces = [ "busybox" ];
  passthru.apk.license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "findutils-standard-fork-${platform.wasmArch}";
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
