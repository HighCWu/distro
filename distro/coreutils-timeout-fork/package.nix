# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  coreutils,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  configureFlags = [
    "--disable-nls"
    "--disable-acl"
    "--disable-libcap"
    "--without-selinux"
  ];
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "coreutils-timeout-fork";
  inherit (coreutils) version src;
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
  ];

  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-automatic-poll-libc.configSite} \
      CC=wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=llvm-ar RANLIB=llvm-ranlib CFLAGS=-O2 \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/ \
        ${lib.escapeShellArgs configureFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    node --test ${./.}/package.test.js

    cmp ${coreutils.src}/src/timeout.c src/timeout.c
    sha256sum src/timeout.c > timeout-source.sha256

    # Automake prepares generated gnulib headers through BUILT_SOURCES for
    # aggregate targets, not a single src/timeout target in a clean tree.
    printf 'sdk-generated-headers: $(BUILT_SOURCES)\n' > sdk-generated-headers.mk
    make -f Makefile -f sdk-generated-headers.mk -j"$NIX_BUILD_CORES" sdk-generated-headers
    make -j"$NIX_BUILD_CORES" src/timeout

    cmp ${coreutils.src}/src/timeout.c src/timeout.c
    sha256sum -c timeout-source.sha256
    printf '%s\0' ${lib.escapeShellArgs configureFlags} > configure-arguments.nul
    cp src/timeout timeout.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      timeout.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("timeout.wasm"));
    const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    const imports = WebAssembly.Module.imports(module);
    for (const name of [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ])
      assert.ok(exports.has(name), "automatic fork link omitted " + name);
    assert.ok(
      imports.some(
        ({ module, name, kind }) =>
          module === "linux_user_poll_v2" && name === "checkpoint" && kind === "function",
      ),
      "automatic fork link omitted the libc polling checkpoint",
    );
    NODE

    ${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc -O2 -Wall -Wextra -Werror \
      ${./timeout-signal-helper.c} -o timeout-signal-helper.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      timeout-signal-helper.wasm ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("timeout-signal-helper.wasm"));
    const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    const imports = WebAssembly.Module.imports(module);
    for (const name of [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ])
      assert.ok(exports.has(name), "automatic fork link omitted " + name);
    assert.ok(
      imports.some(
        ({ module, name, kind }) =>
          module === "linux_user_poll_v2" && name === "checkpoint" && kind === "function",
      ),
      "signal helper omitted the libc polling checkpoint",
    );
    NODE
    sha256sum -c timeout-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 timeout.wasm "$out/bin/timeout-fork"
    install -Dm755 timeout-signal-helper.wasm "$out/bin/coreutils-timeout-signal-helper"

    notices="$out/share/licenses/coreutils-timeout-fork"
    materials="$buildMaterials/share/coreutils-timeout-fork-materials"
    mkdir -p "$notices" "$materials"
    cp COPYING "$notices/coreutils-COPYING"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$notices/fork-sdk"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT "$notices/LLVM-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT "$notices/Clang-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT "$notices/LLD-LICENSE.TXT"

    cp Makefile config.log lib/config.h configure-arguments.nul \
      timeout-source.sha256 src/timeout.c ${./package.nix} \
      ${./package.test.js} ${./runtime-test.sh} ${./native-reference.sh} \
      ${./timeout-signal-helper.c} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    printf 'source=coreutils\nversion=%s\n' "$version" > "$materials/source-identity.txt"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  meta = {
    description = "Unpatched GNU timeout using automatic fork and libc polling";
    outputsToInstall = [ "out" ];
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
    ];
    mainProgram = "timeout-fork";
    platforms = lib.platforms.unix;
  };

  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "coreutils-timeout-fork-${platform.wasmArch}";
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
