# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  linux64Abi,
  vm-test,
}:

let
  platform = linux64Abi.wordPlatform;
  inherit (linux64Abi.dependencies)
    muslWord
    baseWord
    runtimesWord
    toolchainWord
    rootWord
    ;

  dynamicSdk = import ../dynamic-loader/sdk.nix {
    inherit pkgs lib platform;
    musl = muslWord;
    sysroot-base = baseWord;
    sysroot = rootWord;
    llvm-toolchain = toolchainWord;
    llvm-runtimes = runtimesWord;
    sdk = linux64Abi.package;
    # Build a separate Linux64-ABI libc++/unwind tree with the dynamic PIC
    # runtime patch. Do not reuse runtimes from the ordinary static SDK.
    sharedCompiler = null;
  };

  product = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "linux64-abi-dynamic-runtime";
    version = "1";
    outputs = [
      "out"
      "buildMaterials"
    ];
    dontUnpack = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -Wl,--export-dynamic \
        ${./dynamic-runtime.c} -o linux64-abi-dynamic-runtime.wasm
      wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
        -Wl,-soname,liblinux64-abi-variadic.so ${./dynamic-library.c} \
        -o liblinux64-abi-variadic.so

      for program in linux64-abi-dynamic-runtime.wasm liblinux64-abi-variadic.so; do
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
      done
      runHook postBuild
    '';

    nativeBuildInputs = [
      dynamicSdk
      pkgs.nodejs
    ];

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin $out/lib $out/share/licenses/linux64-abi-dynamic-runtime
      install -m755 linux64-abi-dynamic-runtime.wasm \
        $out/bin/linux64-abi-dynamic-runtime.wasm
      install -m644 liblinux64-abi-variadic.so $out/lib/liblinux64-abi-variadic.so

      notices=$out/share/licenses/linux64-abi-dynamic-runtime
      install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
      install -Dm644 ${dynamicSdk.buildMaterials}/licenses/SDK-MIT.txt \
        "$notices/SDK-MIT.txt"
      install -Dm644 ${muslWord.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
      install -Dm644 ${dynamicSdk.compiler.licenseSource}/llvm/LICENSE.TXT \
        "$notices/LLVM-LICENSE.TXT"
      install -Dm644 ${dynamicSdk.compiler.licenseSource}/clang/LICENSE.TXT \
        "$notices/Clang-LICENSE.TXT"
      install -Dm644 ${dynamicSdk.compiler.licenseSource}/lld/LICENSE.TXT \
        "$notices/LLD-LICENSE.TXT"
      for component in compiler-rt libcxx libcxxabi libunwind; do
        install -Dm644 ${runtimesWord.src}/"$component"/LICENSE.TXT \
          "$notices/$component-LICENSE.TXT"
      done

      materials=$buildMaterials/share/linux64-abi-dynamic-materials
      mkdir -p "$materials"
      cp ${./dynamic.nix} ${./dynamic-runtime.c} ${./dynamic-library.c} \
        ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$materials/"
      cp ${dynamicSdk.configSite} "$materials/config.site"
      cp ${dynamicSdk.config} "$materials/compiler.cfg"
      cp ${dynamicSdk.cxxConfig} "$materials/compiler-cxx.cfg"
      ln -s ${dynamicSdk.buildMaterials} "$materials/dynamic-sdk"
      ln -s ${linux64Abi.package.buildMaterials} "$materials/static-sdk-materials"
      ln -s ${muslWord.src} "$materials/musl-source"
      ln -s ${runtimesWord.src} "$materials/llvm-runtimes-source"
      ln -s ${dynamicSdk.compiler.licenseSource} "$materials/llvm-toolchain-source"
      runHook postInstall
    '';

    meta.license = with lib.licenses; [
      mit
      asl20
    ];
    passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
    passthru.checks.runtime = vm-test.rawInitramfsTest {
      name = "linux64-abi-dynamic-runtime-wasm64";
      init = "${finalAttrs.finalPackage}/bin/linux64-abi-dynamic-runtime.wasm";
      files = {
        "/plugins/liblinux64-abi-variadic.so" = "${finalAttrs.finalPackage}/lib/liblinux64-abi-variadic.so";
      };
    };
  });
in
{
  package = product;
  sdk = dynamicSdk;
  checks = {
    runtime = product.checks.runtime;
  };
  recurseForDerivations = true;
}
