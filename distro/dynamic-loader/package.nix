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
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "dynamic-loader";
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
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o dynamic-loader.wasm
    # Compile with the Linux ABI; invoke the ordinary Wasm linker for DSOs.
    # The current Clang Linux driver injects a static --table-base for -shared.
    wasm-linux-dlopen-cc -O2 -fPIC -c ${./library-a.c} -o a.o
    wasm-linux-dlopen-cc -O2 -fPIC -c ${./library-b.c} -o b.o
    wasm-ld -m ${platform.wasmArch} --shared --no-entry --shared-memory --import-memory --import-table \
      --unresolved-symbols=import-dynamic \
      --max-memory=${toString platform.maximumMemoryBytes} --export-all --export=__wasm_call_ctors \
      -soname libplugin-a.so a.o -o libplugin-a.so
    wasm-ld -m ${platform.wasmArch} --shared --no-entry --shared-memory --import-memory --import-table \
      --unresolved-symbols=import-dynamic \
      --max-memory=${toString platform.maximumMemoryBytes} --export-all --export=__wasm_call_ctors \
      --rpath=${lib.escapeShellArg "$ORIGIN/deps"} -soname libplugin-b.so b.o libplugin-a.so -o libplugin-b.so
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dynamic-loader.wasm $out/dynamic-loader.wasm
    install -Dm644 libplugin-a.so $out/lib/libplugin-a.so
    install -Dm644 libplugin-b.so $out/lib/libplugin-b.so
    install -Dm644 ${../sdk/LICENSE.MIT} $out/share/licenses/dynamic-loader/LICENSE.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/dynamic-loader/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/dynamic-loader/compiler-rt-LICENSE.TXT
    mkdir -p $buildMaterials/share/dynamic-loader-materials
    cp ${./runtime.c} ${./library-a.c} ${./library-b.c} ${./package.nix} $buildMaterials/share/dynamic-loader-materials/
    ln -s ${sdk-dynamic-loader.buildMaterials} $buildMaterials/share/dynamic-loader-materials/sdk
    runHook postInstall
  '';
  meta.license = lib.licenses.mit;
  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "dynamic-loader-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/dynamic-loader.wasm";
    files = {
      "/plugins/libplugin-b.so" = "${finalAttrs.finalPackage}/lib/libplugin-b.so";
      "/plugins/deps/libplugin-a.so" = "${finalAttrs.finalPackage}/lib/libplugin-a.so";
    };
  };
})
