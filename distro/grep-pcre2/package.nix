# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  platform,
  sdk,
  llvm-toolchain,
  grep,
  pcre2,
  vm-test,
  busybox,
  extraChecks ? { },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "grep-pcre2";
  inherit (grep)
    src
    version
    postPatch
    postFixup
    ;
  outputs = [
    "out"
    "buildMaterials"
  ];
  nativeBuildInputs = [
    sdk
    llvm-toolchain
    pkgs.pkg-config
    pkgs.nodejs
  ];
  buildInputs = [ pcre2 ];
  doCheck = false;

  CC = "${sdk}/bin/wasm-linux-cc";
  AR = "${llvm-toolchain}/bin/llvm-ar";
  RANLIB = "${llvm-toolchain}/bin/llvm-ranlib";
  CFLAGS = "-O2";
  PCRE_CFLAGS = "-I${pcre2}/include";
  PCRE_LIBS = "${pcre2}/lib/libpcre2-8.a";
  PKG_CONFIG_PATH = "${pcre2}/lib/pkgconfig";

  configureFlags = [
    "--disable-nls"
    "--enable-perl-regexp"
  ];

  postInstall = ''
    test -x "$out/bin/grep"
    test "${grep.version}" = 3.11
    grep -F 'PACKAGE_VERSION = 3.11' Makefile
    grep -F "PCRE_LIBS = ${pcre2}/lib/libpcre2-8.a" src/Makefile
    grep -F "PCRE_CFLAGS = -I${pcre2}/include" src/Makefile
    ${llvm-toolchain}/bin/llvm-nm --defined-only "$out/bin/grep" \
      | grep -Eq '[[:space:]]pcre2_compile_8$'
    ${llvm-toolchain}/bin/llvm-nm --defined-only "$out/bin/grep" \
      | grep -Eq '[[:space:]]pcre2_match_8$'
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      "$out/bin/grep" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}

    notices="$out/share/licenses/grep-pcre2"
    materials="$buildMaterials/share/grep-pcre2-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 "$src/COPYING" "$notices/grep-COPYING"
    cp -rL ${pcre2}/share/licenses/pcre2 "$notices/pcre2"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$notices/standard-sdk"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./runtime-test.sh} ${../grep/package.nix} \
      ${../grep/functionality-test.sh} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      config.log config.status config.h Makefile src/Makefile \
      "$materials/"
    ln -s ${grep.src} "$materials/grep-source"
    ln -s ${pcre2.src} "$materials/pcre2-source"
    ln -s ${pcre2.buildMaterials} "$materials/pcre2-build-materials"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses "$materials/standard-sdk-licenses"
    cp "$src/COPYING" "$materials/grep-COPYING"
    cp -rL ${pcre2}/share/licenses/pcre2 "$materials/pcre2-licenses"
    cp "$out/bin/grep" "$materials/grep-wasm"
  '';

  meta = {
    description = "GNU grep 3.11 with statically linked PCRE2 Perl-compatible regex support";
    license = with lib.licenses; [
      gpl3Plus
      bsd3
    ];
  };
  passthru.apk = {
    license = "GPL-3.0-or-later AND BSD-3-Clause WITH PCRE2-exception AND MIT AND Apache-2.0 WITH LLVM-exception";
    replaces = [
      "busybox"
      "grep"
    ];
  };
  passthru.checks = {
    pcre-runtime = vm-test.installedTest {
      name = "grep-pcre2-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
