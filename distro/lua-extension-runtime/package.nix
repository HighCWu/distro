# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  lua-dynamic,
  sdk-dynamic-loader,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "lua-extension-runtime";
  version = "1";
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontUnpack = true;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-dynamic-loader
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
      -I${lua-dynamic.dev}/include ${./module.c} \
      -Wl,-soname,nativeprobe.so -o nativeprobe.so
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      nativeprobe.so ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 nativeprobe.so $out/lib/nativeprobe.so
    notices=$out/share/licenses/lua-extension-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    mkdir -p "$notices/lua-dynamic"
    cp -r ${lua-dynamic}/share/licenses/lua-dynamic/. "$notices/lua-dynamic/"
    mkdir -p $buildMaterials/share/lua-extension-runtime-materials
    cp ${./package.nix} ${./module.c} ${./consumer.lua} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/lua-extension-runtime-materials/
    ln -s ${lua-dynamic.buildMaterials} \
      $buildMaterials/share/lua-extension-runtime-materials/lua-dynamic
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/lua-extension-runtime-materials/dynamic-sdk
    runHook postInstall
  '';

  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "lua-extension-runtime-${platform.wasmArch}";
      init = pkgs.replaceVars ./runtime-test.sh {
        consumer = "/lua-extension-consumer.lua";
      };
      contents = [
        busybox
        lua-dynamic
        finalAttrs.finalPackage
      ];
      files = {
        "/lib/lua/5.4/nativeprobe.so" = "${finalAttrs.finalPackage}/lib/nativeprobe.so";
        "/lua-extension-consumer.lua" = ./consumer.lua;
      };
    };
  }
  // extraChecks;
})
