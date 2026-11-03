# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  coreutils,
  sdk-fork-continuation,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "coreutils-split-standard-fork";
  inherit (coreutils) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-continuation
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.perl
    pkgs.gawk
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-continuation.configSite} CC=wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc AR=llvm-ar RANLIB=llvm-ranlib CFLAGS=-O2 \
      ./configure --build=${pkgs.stdenv.buildPlatform.config} --host=${platform.targetTriple} \
      --prefix=/ --disable-nls --disable-acl --disable-libcap --without-selinux \
      --enable-no-install-program=stdbuf
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmp ${coreutils.src}/src/split.c src/split.c
    # Automake only prepares BUILT_SOURCES automatically for all/check/install,
    # not an individual program target in a clean tree. Keep the upstream
    # generator rules; do not replace gnulib's generated headers with libc's.
    printf 'sdk-generated-headers: $(BUILT_SOURCES)\n' > sdk-generated-headers.mk
    make -f Makefile -f sdk-generated-headers.mk -j$NIX_BUILD_CORES sdk-generated-headers
    make -j$NIX_BUILD_CORES src/split
    cmp ${coreutils.src}/src/split.c src/split.c
    sha256sum src/split.c > program-source.sha256
    wasm-linux-fork-finalize src/split split.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      split.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 split.wasm $out/bin/split
    notices=$out/share/licenses/coreutils-split-fork
    mkdir -p "$notices" $buildMaterials/share/coreutils-split-fork-materials
    cp COPYING "$notices/"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    cp config.h config.log program-source.sha256 ${./package.nix} ${./runtime-test.sh} \
      $buildMaterials/share/coreutils-split-fork-materials/
    ln -s $src $buildMaterials/share/coreutils-split-fork-materials/source
    ln -s ${sdk-fork-continuation.buildMaterials} $buildMaterials/share/coreutils-split-fork-materials/sdk
    runHook postInstall
  '';
  meta = {
    description = "Unpatched GNU split using standard fork in the optional static C profile";
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
    ];
  };
  passthru.apk.replaces = [ "busybox" ];
  passthru.apk.license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "split-standard-fork-${platform.wasmArch}";
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
