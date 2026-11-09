# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  python-dynamic,
  sdk-dynamic-loader,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "python-extension-runtime";
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
      -I${python-dynamic}/usr/include/python3.13 ${./extension.c} \
      -Wl,-soname,_wasmexample.so -o _wasmexample.so
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
      -I${python-dynamic}/usr/include/python3.13 ${./badinit.c} \
      -Wl,-soname,_wasmbadinit.so -o _wasmbadinit.so

    for module in _wasmexample.so _wasmbadinit.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$module" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/share/licenses/python-extension-runtime/python
    install -m644 _wasmexample.so $out/lib/_wasmexample.so
    install -m644 _wasmbadinit.so $out/lib/_wasmbadinit.so
    install -Dm644 ${../sdk/LICENSE.MIT} \
      $out/share/licenses/python-extension-runtime/LICENSE.MIT
    install -Dm644 ${sdk-dynamic-loader.buildMaterials}/licenses/SDK-MIT.txt \
      $out/share/licenses/python-extension-runtime/SDK-MIT.txt
    cp -r ${python-dynamic}/share/licenses/python/. \
      $out/share/licenses/python-extension-runtime/python/

    mkdir -p $buildMaterials/share/python-extension-runtime-materials
    cp ${./package.nix} ${./extension.c} ${./badinit.c} ${./runtime.py} \
      ${./runtime-test.sh} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/python-extension-runtime-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/python-extension-runtime-materials/dynamic-sdk
    ln -s ${python-dynamic.buildMaterials} \
      $buildMaterials/share/python-extension-runtime-materials/python-dynamic
    runHook postInstall
  '';

  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND PSF-2.0 AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "python-extension-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        python-dynamic
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/_wasmexample.so" = "${finalAttrs.finalPackage}/lib/_wasmexample.so";
        "/plugins/_wasmbadinit.so" = "${finalAttrs.finalPackage}/lib/_wasmbadinit.so";
        "/python-address-bits" = builtins.toFile "python-extension-address-bits" (
          toString platform.addressBits + "\n"
        );
        "/python-extension-runtime.py" = ./runtime.py;
      };
    };
  }
  // extraChecks;
})
