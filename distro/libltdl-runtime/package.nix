# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  libltdl,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libltdl-runtime";
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
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -I${libltdl}/include \
      ${./runtime.c} ${libltdl}/lib/libltdl.a -o libltdl-runtime

    # Keep provider.so out of sample.so's link inputs so the direct import stays lazy.
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -c ${./plugin.c} -o plugin.o
    wasm-linux-dlopen-cc -shared -Wl,-soname,sample.so plugin.o -o sample.so

    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -c ${./provider.c} -o provider.o
    wasm-linux-dlopen-cc -shared -Wl,-soname,provider.so provider.o -o provider.so

    for program in libltdl-runtime sample.so provider.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib
    install -Dm755 libltdl-runtime $out/bin/libltdl-runtime
    install -m644 sample.so provider.so $out/lib/

    notices=$out/share/licenses/libltdl-runtime
    mkdir -p "$notices"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${libltdl}/share/licenses/libltdl/COPYING "$notices/libltdl-COPYING"
    install -Dm644 ${libltdl}/share/licenses/libltdl/COPYING.LIB "$notices/libltdl-COPYING.LIB"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"

    mkdir -p $buildMaterials/share/libltdl-runtime-materials
    cp ${./package.nix} ${./runtime.c} ${./plugin.c} ${./provider.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/libltdl-runtime-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/libltdl-runtime-materials/dynamic-sdk
    ln -s ${libltdl.buildMaterials} $buildMaterials/share/libltdl-runtime-materials/libltdl
    ln -s ${libltdl}/lib/libltdl.a $buildMaterials/share/libltdl-runtime-materials/libltdl.a
    runHook postInstall
  '';

  meta.license = with lib.licenses; [
    mit
    lgpl2Plus
  ];
  passthru.apk.license = "MIT AND LGPL-2.0-or-later AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "libltdl-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/sample.so" = "${finalAttrs.finalPackage}/lib/sample.so";
        "/plugins/provider.so" = "${finalAttrs.finalPackage}/lib/provider.so";
      };
    };
  }
  // extraChecks;
})
