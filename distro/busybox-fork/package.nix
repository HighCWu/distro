# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-continuation,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  upstreamPatchManifest = pkgs.writeText "busybox-fork-upstream-patches.json" (
    builtins.toJSON (map toString pkgs.busybox.patches)
  );
  upstreamPatchCopies = lib.concatStringsSep "\n" (
    lib.imap0 (index: patch: ''
      cp ${lib.escapeShellArg (toString patch)} \
        "$materials/upstream-patches/${toString (index + 1)}-${builtins.baseNameOf (toString patch)}"
    '') pkgs.busybox.patches
  );
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "busybox-fork";
  version = pkgs.busybox.version;
  src = pkgs.busybox.src;
  patches = pkgs.busybox.patches;
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
    pkgs.nodejs
  ];

  makeFlags = [
    "ARCH=${platform.wasmArch}"
    "CC=wasm-linux-fork-cc"
    "AR=llvm-ar"
    "NM=llvm-nm"
    "RANLIB=llvm-ranlib"
    "HOSTCC=${pkgs.stdenv.cc}/bin/cc"
    "HOSTCFLAGS=-O2 -std=gnu17"
  ];

  postPatch = ''
    sha256sum shell/ash.c libbb/vfork_daemon_rexec.c > source-checksum.sha256
  '';

  configurePhase = ''
    runHook preConfigure
    make -j$NIX_BUILD_CORES ${lib.escapeShellArgs finalAttrs.makeFlags} allnoconfig
    sh ${./configure.sh}
    make -j$NIX_BUILD_CORES ${lib.escapeShellArgs finalAttrs.makeFlags} oldconfig
    grep -qx '# CONFIG_NOMMU is not set' .config
    grep -qx 'CONFIG_STATIC=y' .config
    grep -qx 'CONFIG_INSTALL_NO_USR=y' .config
    grep -Fx 'CONFIG_BUSYBOX_EXEC_PATH="/opt/busybox-fork/bin/busybox"' .config
    grep -Fx 'CONFIG_EXTRA_CFLAGS="-O2 -std=gnu17 -mllvm -wasm-enable-sjlj"' .config
    sha256sum -c source-checksum.sha256
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    node --test ${./.}/package.test.js
    sha256sum -c source-checksum.sha256
    make -j$NIX_BUILD_CORES ${lib.escapeShellArgs finalAttrs.makeFlags} \
      busybox_unstripped busybox.links
    wasm-linux-fork-finalize busybox_unstripped busybox
    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./helper.c} -o busybox-fork-helper
    for binary in busybox busybox-fork-helper; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    sha256sum -c source-checksum.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/opt/busybox-fork"
    sh applets/install.sh "$out/opt/busybox-fork" --symlinks
    ln -s ../opt/busybox-fork/bin/busybox "$out/bin/busybox-fork"
    install -Dm755 busybox-fork-helper "$out/bin/busybox-fork-helper"

    notices="$out/share/licenses/busybox-fork"
    materials="$buildMaterials/share/busybox-fork-materials"
    mkdir -p "$notices" "$materials/upstream-patches"
    cp LICENSE "$notices/LICENSE"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-continuation.buildMaterials}/licenses "$notices/fork-sdk"

    cp .config include/autoconf.h include/common_bufsiz.h source-checksum.sha256 \
      ${./package.nix} ${./configure.sh} ${./helper.c} ${./runtime-test.sh} \
      ${./package.test.js} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    cp ${upstreamPatchManifest} "$materials/upstream-patches.json"
    ${upstreamPatchCopies}
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-continuation.buildMaterials} "$materials/fork-sdk"
    ln -s ${musl.src} "$materials/musl-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    runHook postInstall
  '';

  meta = {
    description = "Upstream BusyBox 1.37.0 using the opt-in standard fork profile";
    license = [
      lib.licenses.gpl2Only
      lib.licenses.mit
    ];
  };

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "busybox-fork-${platform.wasmArch}";
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
