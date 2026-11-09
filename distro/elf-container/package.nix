# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  sdk-elf-container,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "elf-container-runtime";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    ${sdk}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror ${./main.c} \
      -o elf-container-runtime.wasm
    ${sdk-elf-container}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./helper.c} -o elf-container-helper.elf
    node ${./inspect.mjs} elf-container-helper.elf ${toString platform.addressBits} \
      elf-container-helper.wasm

    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      elf-container-runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      elf-container-helper.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/licenses/elf-container-runtime
    install -m755 elf-container-runtime.wasm $out/bin/elf-container-runtime
    install -m755 elf-container-helper.elf $out/bin/elf-container-helper
    install -Dm644 ${../sdk/LICENSE.MIT} \
      $out/share/licenses/elf-container-runtime/LICENSE.MIT
    cp -r ${sdk-elf-container}/share/linux-wasm-sdk/licenses \
      $out/share/licenses/elf-container-runtime/elf-container-sdk
    cp ${musl.src}/COPYRIGHT $out/share/licenses/elf-container-runtime/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      $out/share/licenses/elf-container-runtime/compiler-rt-LICENSE.TXT

    materials=$buildMaterials/share/elf-container-runtime-materials
    mkdir -p "$materials"
    cp ${./package.nix} ${./main.c} ${./helper.c} ${./runtime-test.sh} ${./inspect.mjs} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-elf-container.buildMaterials} "$materials/elf-container-sdk"
    ln -s ${musl.src} "$materials/musl-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    runHook postInstall
  '';

  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "elf-container-runtime-${platform.wasmArch}";
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
