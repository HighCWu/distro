# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-automatic,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  configureFlags = [
    "--disable-acl-support"
    "--disable-lz4"
    "--disable-openssl"
    "--disable-xattr-support"
    "--disable-xxhash"
    "--disable-zstd"
    "--enable-ipv6"
    "--with-included-popt"
    "--with-included-zlib"
    "--with-nobody-group=nogroup"
  ];
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "rsync-fork";
  inherit (pkgs.rsync) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  setOutputFlags = false;

  nativeBuildInputs = [
    sdk
    sdk-fork-automatic
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.gawk
    pkgs.gnumake
    pkgs.nodejs
    pkgs.perl
  ];

  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-automatic.configSite} \
      CC=wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=llvm-ar RANLIB=llvm-ranlib CFLAGS=-O2 \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/opt/rsync-fork \
        ${lib.escapeShellArgs configureFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    node --test ${./.}/package.test.js

    # These process and IPC files come directly from the pinned upstream
    # archive. Their ordinary fork/socketpair/pipe paths stay enabled.
    for source_file in main.c pipe.c util1.c; do
      tar -xOf ${pkgs.rsync.src} "rsync-${finalAttrs.version}/$source_file" | cmp - "$source_file"
    done
    sha256sum ${pkgs.rsync.src} > source-archive.sha256
    sha256sum main.c pipe.c util1.c > process-source.sha256
    printf '%s\0' ${lib.escapeShellArgs configureFlags} > configure-arguments.nul

    make -j"$NIX_BUILD_CORES" rsync
    sha256sum -c process-source.sha256

    cp rsync rsync.wasm
    wasm-linux-fork-cc -O2 -Wall -Wextra -Werror \
      ${./rsync-fork-helper.c} -o rsync-fork-helper.wasm

    for binary in rsync.wasm rsync-fork-helper.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
      node --input-type=module - "$binary" <<'NODE'
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";

      const path = process.argv[2];
      const module = new WebAssembly.Module(readFileSync(path));
      const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
      for (const name of [
        "asyncify_get_state",
        "asyncify_start_unwind",
        "asyncify_stop_unwind",
        "asyncify_start_rewind",
        "asyncify_stop_rewind",
      ])
        assert.ok(exports.has(name), "automatic fork link omitted " + name + " from " + path);
    NODE
    done
    sha256sum -c source-archive.sha256
    sha256sum -c process-source.sha256
    runHook postBuild
  '';

  installPhase = ''
        runHook preInstall
        mkdir -p "$out/bin" "$out/opt/rsync-fork/bin" "$out/opt/rsync-fork/libexec"
        install -m755 rsync.wasm "$out/opt/rsync-fork/bin/rsync"
        install -m755 rsync-fork-helper.wasm \
          "$out/opt/rsync-fork/libexec/rsync-fork-helper"
        cat > "$out/bin/rsync-fork" <<'SH'
    #!/bin/sh
    exec /opt/rsync-fork/bin/rsync "$@"
    SH
        chmod 0755 "$out/bin/rsync-fork"

        notices="$out/share/licenses/rsync-fork"
        materials="$buildMaterials/share/rsync-fork-materials"
        mkdir -p "$notices" "$materials"
        cp COPYING "$notices/rsync-COPYING"
        cp popt/COPYING "$notices/popt-COPYING"
        cp zlib/zlib.h "$notices/zlib-license-source.h"
        cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
        cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
        cp -r ${sdk-fork-automatic.buildMaterials}/licenses "$notices/fork-sdk"
        cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
        cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
          "$notices/compiler-rt-LICENSE.TXT"
        cp ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT "$notices/LLVM-LICENSE.TXT"
        cp ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT "$notices/Clang-LICENSE.TXT"
        cp ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT "$notices/LLD-LICENSE.TXT"

        printf 'source=rsync\nversion=%s\narchive=%s\n' "$version" "$src" \
          > "$materials/source-identity.txt"
        cp Makefile config.h config.log configure-arguments.nul source-archive.sha256 \
          process-source.sha256 \
          ${./package.nix} ${./package.test.js} ${./native-reference.sh} \
          ${./runtime-test.sh} ${./rsync-fork-helper.c} \
          ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$materials/"
        cp COPYING "$materials/rsync-COPYING"
        cp popt/COPYING "$materials/popt-COPYING"
        cp zlib/zlib.h "$materials/zlib-license-source.h"
        ln -s "$src" "$materials/source-archive"
        ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
        ln -s ${sdk-fork-automatic.buildMaterials} "$materials/fork-sdk"
        ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
        ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
        ln -s ${musl.src} "$materials/musl-source"
        runHook postInstall
  '';

  meta = {
    description = "Unmodified upstream rsync using the automatic C fork profile";
    outputsToInstall = [ "out" ];
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
      lib.licenses.zlib
    ];
    mainProgram = "rsync-fork";
    platforms = lib.platforms.unix;
  };

  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND zlib AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "rsync-fork-${platform.wasmArch}";
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
