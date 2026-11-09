# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sqlite3-dynamic,
  sdk-dynamic-loader,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "sqlite3-extension-runtime";
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
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
      -I${sqlite3-dynamic}/include ${./extension.c} \
      -Wl,-soname,sample.so -o sample.so
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      sample.so ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/share/licenses/sqlite3-extension-runtime
    install -m644 sample.so $out/lib/sample.so
    install -Dm644 ${../sdk/LICENSE.MIT} \
      $out/share/licenses/sqlite3-extension-runtime/LICENSE.MIT
    cp -r ${sqlite3-dynamic}/share/licenses/sqlite3-dynamic \
      $out/share/licenses/sqlite3-extension-runtime/

    mkdir -p $buildMaterials/share/sqlite3-extension-runtime-materials
    cp ${./package.nix} ${./extension.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/dynamic-sdk
    ln -s ${sqlite3-dynamic.buildMaterials} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/sqlite3-dynamic
    runHook postInstall
  '';

  meta.license = with lib.licenses; [
    mit
    publicDomain
  ];
  passthru.apk.license = "MIT AND blessing AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "sqlite3-extension-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        sqlite3-dynamic
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/sample.so" = "${finalAttrs.finalPackage}/lib/sample.so";
      };
    };
  }
  // extraChecks;
})
