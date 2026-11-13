# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-dynamic-loader,
  llvm-toolchain,
  vm-test,
  busybox,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "libffi-runtime-${platform.wasmArch}";
  inherit (pkgs.libffi) src version;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontConfigure = true;
  dontFixup = true;
  patches = [ ./raw-wasm-backend.patch ];
  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.gnumake
    pkgs.nodejs
  ];

  postPatch = ''
    cp ${./ffi-linux-wasm.c} src/wasm/ffi.c
    cp ${./ffi-module-builder.c} ${./ffi-module-builder.h} src/wasm/
    cp ${./module-transport.c} ${./module-transport.h} src/wasm/
  '';

  buildPhase = ''
    runHook preBuild

    CC=${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      AR=${llvm-toolchain}/bin/llvm-ar \
      RANLIB=${llvm-toolchain}/bin/llvm-ranlib \
      CFLAGS="-O2 -DFFI_WASM_MAX_MEMORY_BYTES=${toString platform.maximumMemoryBytes}" \
      ./configure \
        --host=${platform.targetTriple} \
        --prefix="$out" \
        --enable-static \
        --disable-shared \
        --disable-docs

    grep -Fq 'wasm-linux-dlopen-cc' Makefile config.log
    grep -Fq 'FFI_WASM_MAX_MEMORY_BYTES=${toString platform.maximumMemoryBytes}' Makefile
    grep -Fq 'SOURCES="ffi.c ffi-module-builder.c module-transport.c"' configure.host

    make --jobs="$NIX_BUILD_CORES"
    make install
    test -s "$out/lib/libffi.a"
    test -s "$out/include/ffi.h"
    test -s "$out/include/ffitarget.h"

    mkdir -p build
    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc -std=c11 -O2 -Wall -Wextra -Werror \
      -I"$out/include" ${./runtime.c} "$out/lib/libffi.a" -lm \
      -o build/libffi-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      build/libffi-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    install -Dm755 build/libffi-runtime "$out/bin/libffi-runtime"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    notices="$out/share/licenses/libffi-runtime"
    materials="$buildMaterials/share/libffi-runtime-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE "$notices/libffi-LICENSE"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -r ${sdk-dynamic-loader.buildMaterials}/licenses "$notices/standard-sdk"

    cp ${./package.nix} ${./raw-wasm-backend.patch} \
      ${./ffi-linux-wasm.c} ${./ffi-module-builder.c} ${./ffi-module-builder.h} \
      ${./module-transport.c} ${./module-transport.h} ${./runtime.c} \
      ${./runtime-test.sh} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      configure.host config.log Makefile "$materials/"
    ln -s "$src" "$materials/source"
    ln -s ${pkgs.libffi.src} "$materials/upstream-source"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp LICENSE "$materials/libffi-LICENSE"
    cp "$out/lib/libffi.a" "$out/include/ffi.h" "$out/include/ffitarget.h" \
      "$out/bin/libffi-runtime" "$materials/"

    runHook postInstall
  '';

  meta = {
    description = "Static libffi with raw Linux-Wasm scalar and pointer calls";
    license = pkgs.libffi.meta.license;
  };

  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "libffi-runtime-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
  };
})
