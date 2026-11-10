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
  gdbm ? pkgs.gdbm,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gdbm-runtime-${platform.wasmArch}";
  inherit (gdbm) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontCheck = true;
  dontFixup = true;
  dontStrip = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.bison
    pkgs.flex
    pkgs.gnumake
    pkgs.nodejs
    pkgs.texinfo
    pkgs.updateAutotoolsGnuConfigScriptsHook
  ];

  configurePhase = ''
    runHook preConfigure

    source_tree="$(pwd -P)"
    test -f "$source_tree/configure"
    test -f "$source_tree/COPYING"

    configure_args=(
      --build=${lib.escapeShellArg pkgs.stdenv.buildPlatform.config}
      --host=${lib.escapeShellArg platform.targetTriple}
      --prefix=/
      --disable-memory-mapped-io
      --enable-libgdbm-compat
      --disable-shared
      --enable-static
      --disable-nls
      --without-readline
    )
    CONFIG_SITE=${sdk}/share/linux-wasm-sdk/config.site \
      CC=${sdk}/bin/wasm-linux-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      CFLAGS=-O2 \
      "$source_tree/configure" "''${configure_args[@]}" > configure.out 2>&1
    cat configure.out
    printf '%s\0' "''${configure_args[@]}" > configure-arguments.nul

    grep -F 'Memory mapped I/O ............................. no' configure.out
    grep -Fx '/* #undef HAVE_MMAP */' autoconf.h
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild

    make -j"$NIX_BUILD_CORES"
    test -s src/.libs/libgdbm.a
    test -s compat/.libs/libgdbm_compat.a
    test -x tools/gdbmtool
    test -n "$(${llvm-toolchain}/bin/llvm-ar t src/.libs/libgdbm.a)"
    test -n "$(${llvm-toolchain}/bin/llvm-ar t compat/.libs/libgdbm_compat.a)"

    mkdir -p build/runtime
    ${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc \
      -std=c11 -O2 -Wall -Wextra -Werror \
      -I"$(pwd -P)" -I"$(pwd -P)/src" \
      ${./runtime.c} src/.libs/libgdbm.a \
      -o build/runtime/gdbm-runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/runtime/gdbm-runtime.wasm ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("build/runtime/gdbm-runtime.wasm"));
    const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    const imports = WebAssembly.Module.imports(module);
    for (const name of [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ])
      assert.ok(exports.has(name), "fork-poll compile omitted " + name);
    assert.ok(
      imports.some(
        ({ module, name, kind }) =>
          module === "linux_user_poll_v2" && name === "checkpoint" && kind === "function",
      ),
      "fork-poll compile omitted the libc checkpoint",
    );
    NODE

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    source_tree="$(pwd -P)"
    test -f "$source_tree/COPYING"
    test -f "$source_tree/src/gdbm.h"
    test -f "$source_tree/autoconf.h"

    make install DESTDIR="$out"
    install -dm755 "$out/include/gdbm"
    ln -s ../dbm.h "$out/include/gdbm/dbm.h"
    ln -s ../gdbm.h "$out/include/gdbm/gdbm.h"
    ln -s ../ndbm.h "$out/include/gdbm/ndbm.h"
    install -Dm755 build/runtime/gdbm-runtime.wasm "$out/bin/gdbm-runtime"
    test -s "$out/lib/libgdbm.a"
    test -s "$out/lib/libgdbm_compat.a"
    test -x "$out/bin/gdbmtool"
    test -f "$out/include/gdbm.h"
    test -f "$out/include/dbm.h"
    test -f "$out/include/ndbm.h"
    test -L "$out/include/gdbm/gdbm.h"

    notices="$out/share/licenses/gdbm-runtime"
    materials="$buildMaterials/share/gdbm-runtime-materials"
    mkdir -p "$notices" "$materials/licenses/dependencies"
    install -Dm644 "$source_tree/COPYING" "$notices/gdbm-COPYING"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$notices/fork-poll-sdk"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT "$notices/LLVM-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT "$notices/Clang-LICENSE.TXT"
    cp ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./runtime.c} configure.out configure-arguments.nul \
      config.log config.status autoconf.h Makefile src/Makefile \
      compat/Makefile tools/Makefile src/gdbm.h \
      "$materials/"
    install -Dm644 "$source_tree/COPYING" \
      "$materials/licenses/dependencies/gdbm-COPYING"
    cp ${../sdk/LICENSE.MIT} "$materials/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp -rL ${sdk-fork-automatic-poll-libc.buildMaterials}/licenses \
      "$materials/fork-poll-sdk-licenses"
    cp ${musl.src}/COPYRIGHT "$materials/licenses/dependencies/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$materials/licenses/dependencies/compiler-rt-LICENSE.TXT"
    cp "$out/lib/libgdbm.a" "$out/lib/libgdbm_compat.a" \
      "$out/bin/gdbmtool" "$out/bin/gdbm-runtime" "$materials/"
    printf 'source: GNU GDBM %s from locked Nixpkgs gdbm.src\n' "$version" \
      > "$materials/source-identity.txt"
    printf 'configure: --disable-memory-mapped-io --enable-libgdbm-compat --disable-shared --enable-static\n' \
      >> "$materials/source-identity.txt"
    printf 'runtime: standard gdbm.h binary CRUD and persistence; separate-process writer lock conflict and recovery\n' \
      >> "$materials/source-identity.txt"
    ln -s "$src" "$materials/source-archive.tar.gz"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-poll-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"

    runHook postInstall
  '';

  meta = {
    description = "Static GNU GDBM, compatibility library, gdbmtool, and runtime consumer";
    homepage = "https://www.gnu.org/software/gdbm/";
    license = [
      lib.licenses.gpl3Plus
      lib.licenses.mit
    ];
    mainProgram = "gdbmtool";
  };

  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "gdbm-runtime-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/bin/gdbm-runtime";
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 1;
    };
  }
  // extraChecks;
})
