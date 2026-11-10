# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  gawk,
  sdk,
  sdk-fork-automatic,
  llvm-toolchain,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gawk-fork";
  inherit (gawk) version src;
  patches = [ ];
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  dontPatchShebangs = true;

  nativeBuildInputs = [
    sdk
    sdk-fork-automatic
    llvm-toolchain
    pkgs.gawk
    pkgs.gnumake
    pkgs.nodejs
    pkgs.stdenv.cc
  ];

  configurePhase = ''
    runHook preConfigure
    export CONFIG_SITE=${sdk-fork-automatic.configSite}
    export CC=${sdk-fork-automatic}/bin/wasm-linux-fork-cc
    export CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc
    export BUILD_CC=${pkgs.stdenv.cc}/bin/cc
    export AR=${llvm-toolchain}/bin/llvm-ar
    export RANLIB=${llvm-toolchain}/bin/llvm-ranlib
    export CFLAGS="-O2"

    ./configure \
      --build=${pkgs.stdenv.buildPlatform.config} \
      --host=${platform.targetTriple} \
      --prefix=/ \
      --datadir=/usr/share \
      --libexecdir=/usr/libexec \
      --disable-extensions \
      --disable-nls \
      --without-readline \
      --disable-mpfr \
      --disable-pma

    for source_file in builtin.c io.c; do
      cmp ${gawk.src}/"$source_file" "$source_file"
    done
    sha256sum builtin.c io.c > process-source.sha256
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    sha256sum --check process-source.sha256
    make -C support -j"$NIX_BUILD_CORES"
    make -j"$NIX_BUILD_CORES" gawk

    for source_file in builtin.c io.c; do
      cmp ${gawk.src}/"$source_file" "$source_file"
    done
    sha256sum --check process-source.sha256
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      gawk ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 gawk "$out/bin/gawk-fork"
    install -Dm644 ${./runtime.awk} "$out/usr/share/gawk-fork/runtime.awk"

    notices="$out/share/licenses/gawk-fork"
    materials="$buildMaterials/share/gawk-fork-materials"
    mkdir -p "$notices/gawk-source" "$materials"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    for license_file in "$src"/COPYING*; do
      if [ -f "$license_file" ]; then
        install -Dm644 "$license_file" \
          "$notices/gawk-source/''${license_file##*/}"
      fi
    done
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-automatic.buildMaterials}/licenses "$notices/automatic-fork-sdk"

    cp ${./package.nix} ${./runtime.awk} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      config.h config.log Makefile process-source.sha256 gawk \
      "$materials/"
    cp support/Makefile "$materials/support-Makefile"
    cp ${sdk-fork-automatic.configSite} "$materials/fork-config.site"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp -r ${sdk-fork-automatic.buildMaterials}/licenses \
      "$materials/automatic-fork-sdk-licenses"
    for license_file in "$src"/COPYING*; do
      if [ -f "$license_file" ]; then
        cp "$license_file" "$materials/"
      fi
    done
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic.buildMaterials} "$materials/automatic-fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    runHook postInstall
  '';

  meta = {
    description = "Unpatched GNU Awk using the automatic static C fork profile";
    license = with lib.licenses; [
      gpl3Plus
      mit
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "gawk-fork-${platform.wasmArch}";
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
