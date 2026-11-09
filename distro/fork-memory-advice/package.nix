# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "fork-memory-advice";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-continuation
    pkgs.nodejs
  ];
  buildPhase = ''
    runHook preBuild
    wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
    wasm-linux-fork-finalize linked.wasm runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 runtime.wasm $out/bin/fork-memory-advice
    notices=$out/share/licenses/fork-memory-advice
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp -r ${sdk-fork-continuation.buildMaterials}/licenses/. "$notices/"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/fork-memory-advice-materials
    cp ${./package.nix} ${./runtime.c} ${./runtime-test.sh} \
      $buildMaterials/share/fork-memory-advice-materials/
    ln -s ${sdk-fork-continuation.buildMaterials} \
      $buildMaterials/share/fork-memory-advice-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fork-memory-advice-${platform.wasmArch}";
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
