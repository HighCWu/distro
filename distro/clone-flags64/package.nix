# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  lib,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "clone-flags64";
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
    wasm-linux-fork-finalize linked.wasm clone-flags64.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      clone-flags64.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 clone-flags64.wasm $out/clone-flags64.wasm
    notices=$out/share/licenses/clone-flags64
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/clone-flags64-materials
    cp ${./runtime.c} ${./package.nix} $buildMaterials/share/clone-flags64-materials/
    ln -s ${sdk-fork-continuation.buildMaterials} $buildMaterials/share/clone-flags64-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "clone-flags64-${platform.wasmArch}";
      init = "${finalAttrs.finalPackage}/clone-flags64.wasm";
      cpus = 2;
    };
  }
  // extraChecks;
})
