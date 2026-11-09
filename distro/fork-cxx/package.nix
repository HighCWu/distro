# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-cxx,
  sdk,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "fork-cxx-${platform.wasmArch}";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontConfigure = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-cxx
    sdk
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    cp ${./runtime.cc} runtime.cc
    cmp ${./runtime.cc} runtime.cc
    sha256sum runtime.cc > fork-cxx-source.sha256

    cat > configure-probe.c <<'C'
    int main(void) { return 0; }
    C
    wasm-linux-fork-cc -O0 -Wall -Wextra -Werror configure-probe.c -o configure-probe.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      configure-probe.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    wasm-linux-fork-c++ -std=c++17 -O0 -pthread -Wall -Wextra -Werror \
      -c runtime.cc -o runtime.o
    wasm-linux-fork-c++ -std=c++17 -O0 -pthread -Wall -Wextra -Werror \
      runtime.o -o fork-cxx.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      fork-cxx.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("fork-cxx.wasm"));
    const exports = new Map(
      WebAssembly.Module.exports(module).map(({ name, kind }) => [name, kind]),
    );
    for (const name of [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
      "__wasm_fork_syscall_abi",
      "__wasm_fork_cxx_quiescent_v1",
    ])
      assert.equal(exports.get(name), "function", "missing function export " + name);
    assert.equal(exports.get("__cpp_exception"), "tag", "missing canonical C++ exception tag");
    for (const name of ["__stack_pointer", "__tls_base"])
      assert.equal(exports.get(name), "global", "missing fork TLS/stack global " + name);
    NODE

    cmp ${./runtime.cc} runtime.cc
    sha256sum --check fork-cxx-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 fork-cxx.wasm "$out/fork-cxx.wasm"

    notices="$out/share/licenses/fork-cxx"
    materials="$buildMaterials/share/fork-cxx-materials"
    mkdir -p "$notices" "$materials"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    install -Dm644 ${sdk-fork-cxx.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/FORK-SDK-MIT.txt"
    install -Dm644 ${sdk-fork-cxx.buildMaterials}/licenses/Binaryen-LICENSE \
      "$notices/Binaryen-LICENSE"
    for component in libcxx libcxxabi libunwind; do
      test -s "$notices/standard-sdk/llvm-runtimes/$component-LICENSE.TXT"
    done

    cp ${./package.nix} runtime.cc runtime.o configure-probe.c configure-probe.wasm \
      fork-cxx.wasm fork-cxx-source.sha256 \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    ln -s ${sdk-fork-cxx.buildMaterials} "$materials/fork-cxx-sdk"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    runHook postInstall
  '';

  meta = {
    description = "Static single-thread C++ fork continuation with automatic Asyncify final linking";
    license = with lib.licenses; [
      mit
      asl20
    ];
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fork-cxx-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/fork-cxx.wasm";
      cpus = 1;
    };
  }
  // extraChecks;
})
