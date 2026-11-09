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
  pname = "cxx-dynamic-runtime";
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
    wasm-linux-dlopen-c++ -std=c++17 -O2 -Wall -Wextra -Werror -I${./.} \
      -Wl,--export-dynamic ${./main.cc} -o cxx-dynamic-runtime
    wasm-linux-dlopen-c++ -std=c++17 -O2 -Wall -Wextra -Werror -fPIC -shared -I${./.} \
      -Wl,-soname,plugin.so ${./plugin.cc} -o plugin.so

    for program in cxx-dynamic-runtime plugin.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib $out/share/licenses/cxx-dynamic-runtime
    install -m755 cxx-dynamic-runtime $out/bin/cxx-dynamic-runtime
    install -m644 plugin.so $out/lib/plugin.so

    notices=$out/share/licenses/cxx-dynamic-runtime
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
    for component in compiler-rt libcxx libcxxabi libunwind; do
      install -Dm644 ${llvm-runtimes.src}/"$component"/LICENSE.TXT \
        "$notices/$component-LICENSE.TXT"
    done

    mkdir -p $buildMaterials/share/cxx-dynamic-runtime-materials
    cp ${./package.nix} ${./main.cc} ${./plugin.cc} ${./shared.hpp} \
      ${./runtime-test.sh} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/cxx-dynamic-runtime-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/cxx-dynamic-runtime-materials/dynamic-sdk
    ln -s ${llvm-runtimes.src} \
      $buildMaterials/share/cxx-dynamic-runtime-materials/llvm-runtimes-source
    ln -s ${musl.src} $buildMaterials/share/cxx-dynamic-runtime-materials/musl-source
    runHook postInstall
  '';

  meta.license = with lib.licenses; [
    mit
    asl20
  ];
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "cxx-dynamic-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/plugin.so" = "${finalAttrs.finalPackage}/lib/plugin.so";
      };
    };
  }
  // extraChecks;
})
