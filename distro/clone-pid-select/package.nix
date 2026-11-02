# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  lib,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  vm-test,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "clone-pid-select";
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
    wasm-linux-fork-finalize linked.wasm clone-pid-select.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      clone-pid-select.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 clone-pid-select.wasm $out/clone-pid-select.wasm
    notices=$out/share/licenses/clone-pid-select
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/clone-pid-select-materials
    cp ${./runtime.c} ${./package.nix} $buildMaterials/share/clone-pid-select-materials/
    ln -s ${sdk-fork-continuation.buildMaterials} $buildMaterials/share/clone-pid-select-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "clone-pid-select-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/clone-pid-select.wasm";
    cpus = 2;
  };
})
