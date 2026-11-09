# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-automatic,
  sdk,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "fork-automatic-${platform.wasmArch}";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontConfigure = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-automatic
    sdk
    pkgs.gnumake
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    cp ${../fork-continuation/runtime.c} runtime.c
    cp ${../fork-continuation/raw-clone.c} raw-clone.c
    cp ${../fork-continuation/exec-child.c} exec-child.c
    cp ${./Makefile} Makefile

    for source_file in runtime.c raw-clone.c exec-child.c; do
      cmp ${../fork-continuation}/"$source_file" "$source_file"
    done
    cmp ${./Makefile} Makefile
    sha256sum runtime.c raw-clone.c exec-child.c Makefile > fork-automatic-source.sha256

    LC_ALL=C make -j"$NIX_BUILD_CORES" \
      CC=${lib.escapeShellArg "${sdk-fork-automatic}/bin/wasm-linux-fork-cc"} \
      HELPER_CC=${lib.escapeShellArg "${sdk}/bin/wasm-linux-cc"} \
      all
    test -x fork.wasm
    test -x exec-child.wasm

    for source_file in runtime.c raw-clone.c exec-child.c; do
      cmp ${../fork-continuation}/"$source_file" "$source_file"
    done
    cmp ${./Makefile} Makefile
    sha256sum --check fork-automatic-source.sha256

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      fork.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      exec-child.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const moduleAt = (path) => new WebAssembly.Module(readFileSync(path));
    const exportsOf = (module) => new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    const asyncifyExports = [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ];
    const forkExports = exportsOf(moduleAt("fork.wasm"));
    const helperExports = exportsOf(moduleAt("exec-child.wasm"));
    const combined = moduleAt("combined.o");
    const combinedExports = exportsOf(combined);

    for (const name of asyncifyExports) {
      assert.ok(forkExports.has(name), "automatic fork link omitted " + name);
      assert.ok(!helperExports.has(name), "ordinary helper unexpectedly exports " + name);
      assert.ok(!combinedExports.has(name), "partial link unexpectedly transformed " + name);
    }
    assert.equal(
      WebAssembly.Module.customSections(combined, "linking").length,
      1,
      "partial link did not retain its linking metadata",
    );
    NODE
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 fork.wasm "$out/fork.wasm"
    install -Dm755 exec-child.wasm "$out/exec-child.wasm"

    notices="$out/share/licenses/fork-automatic"
    materials="$buildMaterials/share/fork-automatic-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt "$notices/SDK-MIT.txt"
    install -Dm644 ${sdk}/share/linux-wasm-sdk/licenses/musl/COPYRIGHT \
      "$notices/musl-COPYRIGHT"
    install -Dm644 ${sdk}/share/linux-wasm-sdk/licenses/llvm-runtimes/compiler-rt-LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"

    cp Makefile runtime.c raw-clone.c exec-child.c fork-automatic-source.sha256 combined.o \
      ${./package.nix} $materials/
    ln -s ${sdk-fork-automatic.buildMaterials} "$materials/automatic-fork-sdk"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    runHook postInstall
  '';

  meta = {
    description = "Fork continuation with automatic O0 final-link transformation";
    license = lib.licenses.mit;
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fork-automatic-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/fork.wasm";
      files."/fork-exec" = "${finalAttrs.finalPackage}/exec-child.wasm";
      cpus = 2;
    };
  }
  // extraChecks;
})
