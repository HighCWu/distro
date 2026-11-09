# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  make,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "make-dynamic";
  inherit (make) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;

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
    export make_cv_synchronous_posix_spawn=yes

    ./configure \
      --build=${pkgs.stdenv.buildPlatform.config} \
      --host=${platform.targetTriple} \
      --prefix=/opt/make-dynamic \
      --enable-load \
      --without-guile \
      --disable-nls

    for macro in \
      HAVE_DECL_DLOPEN \
      HAVE_DECL_DLSYM \
      HAVE_DECL_DLERROR \
      MAKE_LOAD \
      USE_POSIX_SPAWN; do
      if ! grep -Eq "^#define $macro[[:space:]]+1$" src/config.h; then
        echo "GNU Make configure did not enable $macro" >&2
        exit 1
      fi
    done

    for source_file in src/job.c src/load.c src/loadapi.c src/function.c; do
      cmp ${make.src}/"$source_file" "$source_file"
    done
    sha256sum src/job.c src/load.c src/loadapi.c src/function.c > process-load-source.sha256
    sha256sum -c process-load-source.sha256
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    sha256sum -c process-load-source.sha256
    make -C lib -j$NIX_BUILD_CORES
    make -j$NIX_BUILD_CORES make

    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      -O2 -Wall -Wextra -Werror -fPIC -shared -I${make.src}/src \
      ${./plugin.c} -Wl,-soname,makeplugin.so -o makeplugin.so
    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      -O2 -Wall -Wextra -Werror -fPIC -shared -I${make.src}/src \
      ${./badplugin.c} -Wl,-soname,badplugin.so -o badplugin.so

    for binary in make makeplugin.so badplugin.so; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    sha256sum -c process-load-source.sha256
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 make "$out/opt/make-dynamic/bin/make"
    mkdir -p "$out/bin" "$out/lib/make-dynamic" "$out/include"
    ln -s ../opt/make-dynamic/bin/make "$out/bin/make-dynamic"
    install -m644 makeplugin.so "$out/lib/make-dynamic/makeplugin.so"
    install -m644 badplugin.so "$out/lib/make-dynamic/badplugin.so"
    install -m644 src/gnumake.h "$out/include/gnumake.h"

    notices="$out/share/licenses/make-dynamic"
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

    materials="$buildMaterials/share/make-dynamic-materials"
    mkdir -p "$materials"
    cp ${./package.nix} ${./plugin.c} ${./badplugin.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      src/config.h config.log process-load-source.sha256 \
      ${sdk-dynamic-loader.configSite} "$materials/"
    cp Makefile "$materials/Makefile"
    cp lib/Makefile "$materials/lib-Makefile"
    ln -s "$src" "$materials/source"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$materials/dynamic-sdk"
    ln -s ${sdk-dynamic-loader.compiler.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
    runHook postInstall
  '';

  meta = {
    description = "GNU Make with the standard load plugin interface enabled";
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
      name = "make-dynamic-${platform.wasmArch}";
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
