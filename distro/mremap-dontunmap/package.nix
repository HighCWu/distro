# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "mremap-dontunmap";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    pkgs.nodejs
  ];
  buildPhase = ''
    runHook preBuild
    wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o runtime.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 runtime.wasm $out/bin/mremap-dontunmap
    notices=$out/share/licenses/mremap-dontunmap
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/mremap-dontunmap-materials
    cp ${./package.nix} ${./runtime.c} ${./runtime-test.sh} \
      $buildMaterials/share/mremap-dontunmap-materials/
    ln -s ${sdk.buildMaterials} $buildMaterials/share/mremap-dontunmap-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "mremap-dontunmap-${platform.wasmArch}";
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
