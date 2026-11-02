# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  vm-test,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "clone-namespaces";
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
    wasm-linux-fork-finalize linked.wasm clone-namespaces.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      clone-namespaces.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 clone-namespaces.wasm $out/clone-namespaces.wasm
    notices=$out/share/licenses/clone-namespaces
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/clone-namespaces-materials
    cp ${./runtime.c} ${./package.nix} $buildMaterials/share/clone-namespaces-materials/
    ln -s ${sdk-fork-continuation.buildMaterials} $buildMaterials/share/clone-namespaces-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "clone-namespaces-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/clone-namespaces.wasm";
    cpus = 2;
  };
})
