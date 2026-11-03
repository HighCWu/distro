# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  vm-test,
}:
let
  sharedFlags = lib.escapeShellArgs [
    "-m"
    platform.wasmArch
    "--shared"
    "--no-entry"
    "--unresolved-symbols=import-dynamic"
    "--shared-memory"
    "--import-memory"
    "--import-table"
    "--max-memory=${toString platform.maximumMemoryBytes}"
    "--export-all"
    "--export=__wasm_call_ctors"
  ];
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "dynamic-symbol-versions";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
  ];
  buildPhase = ''
    runHook preBuild
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o runtime.wasm
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -c ${../symbol-versions/provider.c} -o provider.o
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -c ${./consumer.c} -o consumer.o
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -c ${./missing.c} -o missing.o
    wasm-ld ${sharedFlags} --soname=provider.so provider.o -o provider.so
    wasm-ld ${sharedFlags} --soname=consumer.so --rpath='$ORIGIN' consumer.o provider.so -o consumer.so
    wasm-ld ${sharedFlags} --soname=missing.so --rpath='$ORIGIN' missing.o provider.so -o missing.so
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/share/licenses/dynamic-symbol-versions
    install -m755 runtime.wasm $out/runtime.wasm
    install -m644 provider.so consumer.so missing.so $out/lib/
    cp ${../sdk/LICENSE.MIT} $out/share/licenses/dynamic-symbol-versions/LICENSE.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/dynamic-symbol-versions/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/dynamic-symbol-versions/compiler-rt-LICENSE.TXT
    mkdir -p $buildMaterials/share/dynamic-symbol-versions-materials
    cp ${./runtime.c} ${./consumer.c} ${./missing.c} ${./package.nix} ${../symbol-versions/provider.c} $buildMaterials/share/dynamic-symbol-versions-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} $buildMaterials/share/dynamic-symbol-versions-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "dynamic-symbol-versions-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/runtime.wasm";
    files = {
      "/versions/provider.so" = "${finalAttrs.finalPackage}/lib/provider.so";
      "/versions/consumer.so" = "${finalAttrs.finalPackage}/lib/consumer.so";
      "/versions/missing.so" = "${finalAttrs.finalPackage}/lib/missing.so";
    };
  };
})
