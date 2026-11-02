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
  pname = "file-mmap-stream";
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
    wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o file-mmap-stream.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      file-mmap-stream.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 file-mmap-stream.wasm $out/file-mmap-stream.wasm
    notices=$out/share/licenses/file-mmap-stream
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $buildMaterials/share/file-mmap-stream-materials
    cp ${./runtime.c} ${./package.nix} $buildMaterials/share/file-mmap-stream-materials/
    ln -s ${sdk.buildMaterials} $buildMaterials/share/file-mmap-stream-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "file-mmap-stream-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/file-mmap-stream.wasm";
    cpus = 2;
  };
})
