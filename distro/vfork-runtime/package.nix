# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "vfork-runtime";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk
    sdk-fork-continuation
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./main.c} -o vfork-linked.wasm
    wasm-linux-fork-finalize vfork-linked.wasm vfork-runtime.wasm
    wasm-linux-cc -O2 -Wall -Wextra -Werror ${./helper.c} -o vfork-helper.wasm
    for program in vfork-runtime.wasm vfork-helper.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/licenses/vfork-runtime
    install -m755 vfork-runtime.wasm $out/bin/vfork-runtime
    install -m755 vfork-helper.wasm $out/bin/vfork-helper

    notices=$out/share/licenses/vfork-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp -r ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    cp -r ${sdk-fork-continuation.buildMaterials}/licenses "$notices/fork-sdk"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"

    materials=$buildMaterials/share/vfork-runtime-materials
    mkdir -p "$materials"
    cp ${./package.nix} ${./main.c} ${./helper.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-continuation.buildMaterials} "$materials/fork-sdk"
    ln -s ${musl.src} "$materials/musl-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    runHook postInstall
  '';

  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "vfork-runtime-${platform.wasmArch}";
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
