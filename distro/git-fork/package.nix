# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  git,
  sdk,
  sdk-fork-automatic,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  zlib,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "git-fork";
  inherit (git) version src;
  patches = [ ];
  outputs = [
    "out"
    "buildMaterials"
  ];
  setOutputFlags = false;
  moveToDev = false;
  meta.outputsToInstall = [ "out" ];
  dontFixup = true;
  dontPatchShebangs = true;
  dontConfigure = true;

  nativeBuildInputs = [
    sdk
    sdk-fork-automatic
    llvm-toolchain
    pkgs.stdenv.cc
    pkgs.nodejs
    pkgs.perl
  ];
  buildInputs = [ zlib ];

  makeFlags = [
    "uname_S=Linux"
    "CC=${sdk-fork-automatic}/bin/wasm-linux-fork-cc"
    "AR=${llvm-toolchain}/bin/llvm-ar"
    "RANLIB=${llvm-toolchain}/bin/llvm-ranlib"
    "ZLIB_PATH=${zlib}"
    "NO_PTHREADS=YesPlease"
    "NO_CURL=YesPlease"
    "NO_EXPAT=YesPlease"
    "NO_OPENSSL=YesPlease"
    "NO_RUST=YesPlease"
    "NO_REGEX=YesPlease"
    "NO_PERL=YesPlease"
    "NO_TCLTK=YesPlease"
    "NO_PYTHON=YesPlease"
    "NO_GETTEXT=YesPlease"
    "NO_INSTALL_HARDLINKS=YesPlease"
    "INSTALL_SYMLINKS=YesPlease"
    "LINK_FUZZ_PROGRAMS="
    "PERL_PATH=/usr/bin/perl"
    "prefix=/opt/git-fork"
  ];

  buildPhase = ''
    runHook preBuild
    for source_file in run-command.c setup.c transport-helper.c git.c; do
      cmp ${git.src}/"$source_file" "$source_file"
    done
    sha256sum run-command.c setup.c transport-helper.c git.c > process-source.sha256
    printf '%s\0' ${lib.escapeShellArgs finalAttrs.makeFlags} >git-make-arguments.nul
    make -j$NIX_BUILD_CORES ${lib.escapeShellArgs finalAttrs.makeFlags} all

    if ! grep -q -- '-DNO_PTHREADS' GIT-CFLAGS; then
      echo 'Git build did not define NO_PTHREADS' >&2
      exit 1
    fi
    if grep -q -- '-DNO_POSIX_GOODIES' GIT-CFLAGS; then
      echo 'Git build unexpectedly disabled POSIX fork users' >&2
      exit 1
    fi
    for source_file in run-command.c setup.c transport-helper.c git.c; do
      cmp ${git.src}/"$source_file" "$source_file"
    done
    sha256sum -c process-source.sha256

    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./helper.c} -o git-fork-helper
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      git-fork-helper ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make -j$NIX_BUILD_CORES ${lib.escapeShellArgs finalAttrs.makeFlags} \
      DESTDIR="$out" install

    find "$out" -type f -print0 > installed-files.nul
    : > linked-programs.txt
    linked_count=0
    while IFS= read -r -d "" program; do
      if [ ! -x "$program" ]; then
        continue
      fi
      magic=$(od -An -tx1 -N8 "$program" | tr -d '[:space:]')
      case "$magic" in
        7f454c46*)
          echo "Git install contained a host ELF executable: $program" >&2
          exit 1
          ;;
      esac
      if [ "$magic" != 0061736d01000000 ]; then
        continue
      fi

      WASM_PROGRAM="$program" node --input-type=module <<'NODE'
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";

      const path = process.env.WASM_PROGRAM;
      assert.ok(path, "missing executable Wasm path");
      const module = new WebAssembly.Module(readFileSync(path));
      const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
      const asyncifyExports = [
        "asyncify_get_state",
        "asyncify_start_unwind",
        "asyncify_stop_unwind",
        "asyncify_start_rewind",
        "asyncify_stop_rewind",
      ];
      for (const name of asyncifyExports)
        assert.ok(exports.has(name), "automatic fork link omitted " + name + " from " + path);
    NODE
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
      relative_program=$(realpath --relative-to="$out" "$program")
      printf '%s\n' "$relative_program" >> linked-programs.txt
      linked_count=$((linked_count + 1))
    done < installed-files.nul
    if [ "$linked_count" -eq 0 ]; then
      echo 'Git install contained no executable Wasm modules to validate' >&2
      exit 1
    fi

    mkdir -p "$out/bin"
    printf '%s\n' '#!/bin/sh' 'exec /opt/git-fork/bin/git "$@"' > "$out/bin/git-fork"
    chmod 0755 "$out/bin/git-fork"
    install -Dm755 git-fork-helper "$out/bin/git-fork-helper"
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$out/bin/git-fork-helper" ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}

    notices="$out/share/licenses/git-fork"
    materials="$buildMaterials/share/git-fork-materials"
    mkdir -p "$notices/compat-regex" "$materials"
    install -Dm644 COPYING "$notices/git-COPYING"
    install -Dm644 sha1dc/LICENSE.txt "$notices/sha1dc-LICENSE.txt"
    install -Dm644 reftable/LICENSE "$notices/reftable-LICENSE"
    for name in regcomp.c regex.c regex.h regex_internal.c regex_internal.h regexec.c; do
      install -Dm644 "compat/regex/$name" "$notices/compat-regex/$name"
    done
    install -Dm644 ${zlib.src}/LICENSE "$notices/zlib-LICENSE"
    install -Dm644 ${zlib.src}/zlib.h "$notices/zlib-header-notice.h"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$notices/SDK-MIT.txt"
    install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/FORK-SDK-MIT.txt"
    install -Dm644 ${sdk-fork-automatic.buildMaterials}/licenses/Binaryen-LICENSE \
      "$notices/Binaryen-LICENSE"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"

    cp Makefile GIT-CFLAGS process-source.sha256 git-make-arguments.nul \
      linked-programs.txt ${./package.nix} ${./helper.c} ${./runtime-test.sh} \
      ${../zlib/package.nix} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    cp COPYING "$materials/COPYING"
    ln -s "$src" "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    ln -s ${zlib.src} "$materials/zlib-source"
    runHook postInstall
  '';

  meta = {
    description = "Unpatched Git using the automatic static C fork profile";
    license = [
      lib.licenses.gpl2Only
      lib.licenses.mit
      lib.licenses.zlib
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-2.0-only AND zlib AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "git-fork-${platform.wasmArch}";
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
