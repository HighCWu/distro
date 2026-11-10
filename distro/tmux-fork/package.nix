# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  llvm-runtimes,
  musl,
  ncurses,
  libevent-runtime,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  configureFlags = [
    "--disable-utempter"
    "--disable-utf8proc"
    "--disable-systemd"
    "--disable-cgroups"
    "--with-TERM=tmux-256color"
    "--sysconfdir=/etc"
    "--localstatedir=/var"
  ];
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "tmux-fork";
  inherit (pkgs.tmux) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  setOutputFlags = false;

  nativeBuildInputs = [
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.autoreconfHook
    pkgs.bison
    pkgs.gnumake
    pkgs.nodejs
    pkgs.pkg-config
    pkgs.stdenv.cc
  ];

  configurePhase = ''
    runHook preConfigure
    empty_pkgconfig_dir="$(pwd)/.tmux-fork-empty-pkgconfig"
    mkdir -p "$empty_pkgconfig_dir"
    CONFIG_SITE=${sdk-fork-automatic-poll-libc.configSite} \
      CC=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      CFLAGS=-O2 \
      CPPFLAGS="-I${libevent-runtime}/include -I${ncurses}/include" \
      LDFLAGS="-L${libevent-runtime}/lib -L${ncurses}/lib" \
      PKG_CONFIG=${pkgs.pkg-config}/bin/pkg-config \
      PKG_CONFIG_LIBDIR="$empty_pkgconfig_dir" \
      PKG_CONFIG_PATH= \
      ./configure \
        --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config} \
        --host=${lib.escapeShellArg platform.targetTriple} \
        --prefix=/opt/tmux-fork \
        ${lib.escapeShellArgs configureFlags}
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    node --test ${./.}/package.test.js

    for source_file in configure.ac tmux.c server.c proc.c spawn.c compat/fdforkpty.c; do
      cmp "${pkgs.tmux.src}/$source_file" "$source_file"
    done
    grep -q 'socketpair(AF_UNIX' proc.c
    grep -q 'switch (pid = fork())' proc.c
    grep -q 'new_wp->pid = fdforkpty' spawn.c
    grep -q 'return (forkpty(master' compat/fdforkpty.c
    sha256sum configure.ac tmux.c server.c proc.c spawn.c compat/fdforkpty.c \
      > upstream-source.sha256
    printf '%s\0' ${lib.escapeShellArgs configureFlags} > configure-arguments.nul

    make -j"$NIX_BUILD_CORES"
    test -x tmux
    sha256sum -c upstream-source.sha256
    cp tmux tmux.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      tmux.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("tmux.wasm"));
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
    sha256sum -c upstream-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 tmux.wasm "$out/opt/tmux-fork/bin/tmux"
    mkdir -p "$out/bin"
    cat > "$out/bin/tmux-fork" <<'SH'
    #!/bin/sh
    exec /opt/tmux-fork/bin/tmux "$@"
    SH
    chmod 0755 "$out/bin/tmux-fork"

    notices="$out/share/licenses/tmux-fork"
    materials="$buildMaterials/share/tmux-fork-materials"
    mkdir -p "$notices" "$materials"
    cp COPYING "$notices/tmux-COPYING"
    cp ${ncurses.src}/COPYING "$notices/ncurses-COPYING"
    cp ${libevent-runtime.src}/LICENSE "$notices/libevent-LICENSE"
    cp ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$notices/fork-sdk"
    cp -rL ${libevent-runtime}/share/licenses/libevent-runtime \
      "$notices/libevent-runtime"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT "$notices/LLVM-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT "$notices/Clang-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT "$notices/LLD-LICENSE.TXT"

    printf 'source=tmux\nversion=%s\n' "$version" > "$materials/source-identity.txt"
    cp Makefile config.log config.status configure.ac configure-arguments.nul \
      upstream-source.sha256 ${./package.nix} ${./package.test.js} \
      ${./runtime-test.sh} ${./native-reference.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    cp COPYING "$materials/tmux-COPYING"
    cp ${ncurses.src}/COPYING "$materials/ncurses-COPYING"
    cp ${libevent-runtime.src}/LICENSE "$materials/libevent-LICENSE"
    ln -s "$src" "$materials/source"
    ln -s ${ncurses.src} "$materials/ncurses-source"
    ln -s ${libevent-runtime.src} "$materials/libevent-source"
    ln -s ${libevent-runtime.buildMaterials} "$materials/libevent-build-materials"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${libevent-runtime}/share/licenses/libevent-runtime "$materials/libevent-licenses"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  meta = {
    description = "Unmodified upstream tmux using the automatic fork and polling libc SDK";
    outputsToInstall = [ "out" ];
    license = [
      lib.licenses.isc
      lib.licenses.bsd3
      lib.licenses.mit
    ];
    mainProgram = "tmux-fork";
    platforms = lib.platforms.unix;
  };

  passthru.apk = {
    depends = [
      "busybox"
      "ncurses"
    ];
    license = "ISC AND BSD-3-Clause AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "tmux-fork-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        ncurses
        finalAttrs.finalPackage
      ];
      cpus = 2;
    };
  }
  // extraChecks;
})
