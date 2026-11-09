# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-dynamic-loader,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "dladdr-runtime";
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
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -Wl,--export-dynamic \
      ${./main.c} -o dladdr-runtime
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
      -Wl,-soname,dladdr-plugin.so ${./plugin.c} -o dladdr-plugin.so

    for program in dladdr-runtime dladdr-plugin.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib $out/share/licenses/dladdr-runtime
    install -m755 dladdr-runtime $out/bin/dladdr-runtime
    install -m644 dladdr-plugin.so $out/lib/dladdr-plugin.so

    notices=$out/share/licenses/dladdr-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${sdk-dynamic-loader.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/SDK-MIT.txt"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"

    materials=$buildMaterials/share/dladdr-runtime-materials
    mkdir -p "$materials"
    cp ${./package.nix} ${./main.c} ${./plugin.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$materials/"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$materials/dynamic-sdk"
    ln -s ${sdk-dynamic-loader.compiler.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  meta.license = lib.licenses.mit;
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "dladdr-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 2;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/dladdr-plugin.so" = "${finalAttrs.finalPackage}/lib/dladdr-plugin.so";
      };
    };
  }
  // extraChecks;
})
