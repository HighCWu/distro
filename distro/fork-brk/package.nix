# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-brk,
  sdk,
  llvm-toolchain,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "fork-brk-${platform.wasmArch}";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontConfigure = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-brk
    sdk
    llvm-toolchain
    pkgs.nodejs
    pkgs.gnumake
    pkgs.python3
  ];

  buildPhase = ''
    runHook preBuild
    cp ${./runtime.c} runtime.c
    cp ${../brk-syscall/runtime.c} brk-existing.c
    cp ${../fork-continuation/runtime.c} fork-existing.c
    cp ${../fork-continuation/raw-clone.c} raw-clone.c
    cp ${../fork-continuation/exec-child.c} exec-child.c
    cp ${./Makefile} Makefile

    cmp ${./runtime.c} runtime.c
    cmp ${../brk-syscall/runtime.c} brk-existing.c
    cmp ${../fork-continuation/runtime.c} fork-existing.c
    cmp ${../fork-continuation/raw-clone.c} raw-clone.c
    cmp ${../fork-continuation/exec-child.c} exec-child.c
    cmp ${./Makefile} Makefile
    sha256sum runtime.c brk-existing.c fork-existing.c raw-clone.c exec-child.c Makefile \
      > fork-brk-source.sha256

    make -j"$NIX_BUILD_CORES" \
      CC=${lib.escapeShellArg "${sdk-fork-brk}/bin/wasm-linux-fork-cc"} \
      HELPER_CC=${lib.escapeShellArg "${sdk}/bin/wasm-linux-cc"} \
      all

    python3 ${../brk-syscall/check-object.py} ${llvm-toolchain}/bin/llvm-readobj brk-existing.o
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const limitsObject = new WebAssembly.Module(readFileSync("fork-limits.o"));
    assert.ok(
      WebAssembly.Module.imports(limitsObject).some(({ name }) => name === "malloc"),
      "fork-limits.o must retain its real malloc import for the OOM path",
    );

    const asyncifyExports = [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ];
    const brkExports = ["__wasm_brk_layout_v1", "__wasm_brk_update_v1"];
    for (const file of ["fork-limits.wasm", "brk-existing.wasm", "fork-existing.wasm"]) {
      const module = new WebAssembly.Module(readFileSync(file));
      const names = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
      for (const name of asyncifyExports)
        assert.ok(names.has(name), file + " omitted Asyncify export " + name);
      for (const name of brkExports) assert.ok(names.has(name), file + " omitted brk export " + name);
    }
    const helper = new WebAssembly.Module(readFileSync("exec-child.wasm"));
    const helperExports = new Set(WebAssembly.Module.exports(helper).map(({ name }) => name));
    for (const name of asyncifyExports)
      assert.ok(!helperExports.has(name), "default-SDK helper unexpectedly exports " + name);
    NODE

    for program in fork-limits brk-existing fork-existing exec-child; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program.wasm" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done

    cmp ${./runtime.c} runtime.c
    cmp ${../brk-syscall/runtime.c} brk-existing.c
    cmp ${../fork-continuation/runtime.c} fork-existing.c
    cmp ${../fork-continuation/raw-clone.c} raw-clone.c
    cmp ${../fork-continuation/exec-child.c} exec-child.c
    cmp ${./Makefile} Makefile
    sha256sum --check fork-brk-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    for program in fork-limits brk-existing fork-existing exec-child; do
      install -Dm755 "$program.wasm" "$out/$program.wasm"
    done

    notices="$out/share/licenses/fork-brk"
    materials="$buildMaterials/share/fork-brk-materials"
    mkdir -p "$notices" "$materials"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    install -Dm644 ${sdk-fork-brk.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/fork-sdk/SDK-MIT.txt"
    install -Dm644 ${sdk-fork-brk.buildMaterials}/licenses/Binaryen-LICENSE \
      "$notices/fork-sdk/Binaryen-LICENSE"

    cp Makefile runtime.c brk-existing.c fork-existing.c raw-clone.c exec-child.c \
      fork-brk-source.sha256 ${../brk-syscall/check-object.py} ${./package.nix} \
      $materials/
    cp *.o "$materials/"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-brk.buildMaterials} "$materials/fork-brk-sdk"
    runHook postInstall
  '';

  meta = {
    description = "Fork continuation combined with the routed brk syscall profile";
    license = lib.licenses.mit;
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fork-brk-limits-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/fork-limits.wasm";
      cpus = 2;
    };
    allocator = vm-test.rawInitramfsTest {
      name = "fork-brk-allocator-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/brk-existing.wasm";
      cpus = 2;
    };
    corpus = vm-test.rawInitramfsTest {
      name = "fork-brk-corpus-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/fork-existing.wasm";
      files."/fork-exec" = "${finalAttrs.finalPackage}/exec-child.wasm";
      cpus = 2;
    };
  }
  // extraChecks;
})
