# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  openssl,
  sdk-dynamic-loader,
  llvm-runtimes,
  vm-test,
  busybox,
  extraChecks ? { },
}:
let
  toolchain = sdk-dynamic-loader.compiler;
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "openssl-dynamic-${platform.wasmArch}";
  inherit (openssl) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  patches = [ ../openssl/speed-no-mlock-on-wasm.patch ];
  dontFixup = true;
  dontStrip = true;

  meta = {
    description = "Static OpenSSL libraries with dynamically loadable providers";
    license = [
      lib.licenses.asl20
      lib.licenses.mit
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "Apache-2.0 AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  nativeBuildInputs = [
    sdk-dynamic-loader
    toolchain
    pkgs.gnumake
    pkgs.nodejs
    pkgs.perl
  ];

  configurePhase = ''
    runHook preConfigure
    export CONFIG_SITE=${lib.escapeShellArg sdk-dynamic-loader.configSite}
    export CC=${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc
    export AR=${toolchain}/bin/llvm-ar
    export RANLIB=${toolchain}/bin/llvm-ranlib
    export NM=${toolchain}/bin/llvm-nm

    perl ./Configure linux-generic${toString platform.addressBits} \
      "CC=$CC" "AR=$AR" "RANLIB=$RANLIB" "NM=$NM" \
      -DHAVE_FORK=0 \
      --prefix=/opt/openssl-dynamic \
      --libdir=lib \
      --openssldir=/opt/openssl-dynamic/ssl \
      no-shared \
      no-async \
      no-afalgeng \
      no-secure-memory \
      no-tests
    # linux-generic's static-library and provider compile rules retain PIC
    # independently of the toolchain's non-PIC default and no-shared setting.
    grep -Eq '^LIB_CFLAGS=-fPIC([[:space:]]|$)' Makefile
    grep -Eq '^DSO_CFLAGS=-fPIC([[:space:]]|$)' Makefile
    runHook postConfigure
  '';

  enableParallelBuilding = true;

  buildPhase = ''
    runHook preBuild
    make -j"$NIX_BUILD_CORES"
    test -x apps/openssl
    test -s providers/legacy.so

    ${sdk-dynamic-loader}/bin/wasm-linux-dlopen-cc \
      -O2 -Wall -Wextra -Werror -Iinclude \
      ${./provider-runtime.c} libcrypto.a -ldl -pthread -o provider-runtime.wasm

    for program in apps/openssl providers/legacy.so provider-runtime.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';

  installTargets = [
    "install_sw"
    "install_ssldirs"
  ];
  installFlags = [ "DESTDIR=$(out)" ];

  postInstall = ''
    prefix="$out/opt/openssl-dynamic"
    test -x "$prefix/bin/openssl"
    test -s "$prefix/lib/libcrypto.a"
    test -s "$prefix/lib/ossl-modules/legacy.so"
    test -s "$prefix/ssl/openssl.cnf"
    install -Dm755 provider-runtime.wasm "$prefix/bin/provider-runtime"

    notices="$out/share/licenses/openssl-dynamic"
    materials="$buildMaterials/share/openssl-dynamic-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE.txt "$notices/OPENSSL-LICENSE.txt"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${sdk-dynamic-loader.buildMaterials}/licenses/SDK-MIT.txt \
      "$notices/SDK-MIT.txt"
    install -Dm644 ${sdk-dynamic-loader.buildMaterials}/licenses/musl-COPYRIGHT \
      "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    install -Dm644 ${toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./provider-runtime.c} ${./runtime-test.sh} \
      ${../openssl/speed-no-mlock-on-wasm.patch} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      configdata.pm Makefile "$materials/"
    cp "$CONFIG_SITE" "$materials/config.site"
    ln -s "$src" "$materials/source"
    ln -s ${sdk-dynamic-loader.buildMaterials} "$materials/dynamic-sdk"
    ln -s ${toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    cat >"$materials/build-parameters.txt" <<EOF
    source=OpenSSL $version inherited from openssl.src
    target=linux-generic${toString platform.addressBits}
    CC=$CC
    CONFIG_SITE=$CONFIG_SITE
    AR=$AR
    RANLIB=$RANLIB
    NM=$NM
    Configure=no-shared; provider DSO enabled; linux-generic static-library and provider objects use target PIC flags; no-async; no-afalgeng; no-secure-memory; no-tests
    runtime=OSSL_PROVIDER_load legacy/default; external prefix /opt/openssl-dynamic/lib/ossl-modules
    EOF
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "openssl-dynamic-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 1;
    };
  }
  // extraChecks;
})
