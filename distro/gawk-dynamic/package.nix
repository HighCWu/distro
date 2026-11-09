# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  gawk,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "gawk-dynamic";
  inherit (gawk) version src patches;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  dontPatchShebangs = true;

  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.nodejs
    pkgs.stdenv.cc
  ];

  configurePhase = ''
    runHook preConfigure
    export CONFIG_SITE=${sdk-dynamic-loader.configSite}
    export CC=${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc
    export CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc
    export BUILD_CC=${pkgs.stdenv.cc}/bin/cc
    export AR=${llvm-toolchain}/bin/llvm-ar
    export RANLIB=${llvm-toolchain}/bin/llvm-ranlib
    export CFLAGS="-O2"

    ./configure \
      --build=${pkgs.stdenv.buildPlatform.config} \
      --host=${platform.targetTriple} \
      --prefix=/opt/gawk-dynamic \
      --enable-extensions \
      --disable-nls \
      --without-readline \
      --disable-mpfr \
      --disable-pma

    if ! grep -Eq '^#define DYNAMIC 1$' config.h; then
      echo 'GNU Awk configure did not enable DYNAMIC from its loader probes' >&2
      exit 1
    fi
    if grep -Eq '^#define USE_PERSISTENT_MALLOC 1$' config.h; then
      echo 'GNU Awk configure enabled the unsupported persistent allocator' >&2
      exit 1
    fi
    for source_file in ext.c gawkapi.h; do
      cmp ${gawk.src}/"$source_file" "$source_file"
    done
    sha256sum builtin.c io.c ext.c gawkapi.h > process-api-source.sha256
    sha256sum -c process-api-source.sha256
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    sha256sum -c process-api-source.sha256
    make -C support -j$NIX_BUILD_CORES
    make -j$NIX_BUILD_CORES gawk

    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      -O2 -Wall -Wextra -Werror -fPIC -shared -I${gawk.src} \
      ${./extension.c} -Wl,-soname,wasmext.so -o wasmext.so
    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      -O2 -Wall -Wextra -Werror -fPIC -shared -I${gawk.src} \
      ${./badextension.c} -Wl,-soname,badext.so -o badext.so

    for binary in gawk wasmext.so badext.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    sha256sum -c process-api-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 gawk "$out/opt/gawk-dynamic/bin/gawk"
    mkdir -p "$out/bin" "$out/lib" "$out/opt/gawk-dynamic/lib/gawk" "$out/include"
    ln -s ../opt/gawk-dynamic/bin/gawk "$out/bin/gawk-dynamic"
    ln -s ../opt/gawk-dynamic/lib/gawk "$out/lib/gawk-dynamic"
    install -m644 wasmext.so "$out/opt/gawk-dynamic/lib/gawk/wasmext.so"
    install -m644 badext.so "$out/opt/gawk-dynamic/lib/gawk/badext.so"
    install -m644 gawkapi.h "$out/include/gawkapi.h"

    notices="$out/share/licenses/gawk-dynamic"
    install -Dm644 COPYING "$notices/COPYING"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
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

    materials="$buildMaterials/share/gawk-dynamic-materials"
    mkdir -p "$materials/process-patches"
    cp ${./package.nix} ${./extension.c} ${./badextension.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      config.h config.log process-api-source.sha256 ${sdk-dynamic-loader.configSite} \
      "$materials/"
    cp Makefile "$materials/Makefile"
    cp support/Makefile "$materials/support-Makefile"
    cp ${../gawk/wasm-posix-spawn.patch} "$materials/process-patches/"
    cp ${../gawk/pty-callback-clone.patch} "$materials/process-patches/"
    ln -s "$src" "$materials/source"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$materials/dynamic-sdk"
    ln -s ${sdk-dynamic-loader.compiler.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  meta = {
    description = "GNU Awk with its C extension loader enabled";
    license = with lib.licenses; [
      gpl3Plus
      mit
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "GPL-3.0-or-later AND MIT AND Apache-2.0 WITH LLVM-exception";
  };
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "gawk-dynamic-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 2;
    };
  }
  // extraChecks;
})
