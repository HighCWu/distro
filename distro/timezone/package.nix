# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  lib,
  sdk,
  musl,
  llvm-runtimes,
  vm-test,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "timezone";
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
    wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} \
      -Wl,--wrap=__mmap,--wrap=__munmap -o timezone.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      timezone.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 timezone.wasm $out/timezone.wasm
    notices=$out/share/licenses/timezone
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/timezone-materials
    cp ${./runtime.c} ${./package.nix} $buildMaterials/share/timezone-materials/
    ln -s ${sdk.buildMaterials} $buildMaterials/share/timezone-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "timezone-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/timezone.wasm";
    files = {
      "/tz-west" = "${pkgs.tzdata}/share/zoneinfo/America/New_York";
      "/tz-east" = "${pkgs.tzdata}/share/zoneinfo/Asia/Tokyo";
    };
  };
})
