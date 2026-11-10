# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sqlite3-dynamic,
  sdk-dynamic-loader,
  llvm-toolchain,
  vm-test,
  busybox,
  extraChecks ? { },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "sqlite3-extension-runtime";
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
    pkgs.pkg-config
  ];

  buildPhase = ''
    runHook preBuild
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror -fPIC -shared \
      -I${sqlite3-dynamic}/include ${./extension.c} \
      -Wl,-soname,sample.so -o sample.so

    export PKG_CONFIG_LIBDIR=${sqlite3-dynamic}/lib/pkgconfig
    export PKG_CONFIG_PATH=
    export PKG_CONFIG_SYSROOT_DIR=${sqlite3-dynamic}
    export PKG_CONFIG_SYSTEM_INCLUDE_PATH=
    export PKG_CONFIG_SYSTEM_LIBRARY_PATH=
    sqlite_cflags_text=$(${pkgs.pkg-config}/bin/pkg-config --cflags sqlite3)
    sqlite_libs_text=$(${pkgs.pkg-config}/bin/pkg-config --static --libs sqlite3)
    case "$sqlite_cflags_text $sqlite_libs_text" in
      *${sqlite3-dynamic}*) ;;
      *)
        echo 'SQLite pkg-config flags did not use the installed target package' >&2
        exit 1
        ;;
    esac
    read -ra sqlite_cflags <<<"$sqlite_cflags_text"
    read -ra sqlite_libs <<<"$sqlite_libs_text"
    wasm-linux-dlopen-cc -O2 -Wall -Wextra -Werror \
      "''${sqlite_cflags[@]}" ${./linked-client.c} "''${sqlite_libs[@]}" \
      -o linked-client
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      sample.so ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      linked-client ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib $out/share/licenses/sqlite3-extension-runtime
    install -m644 sample.so $out/lib/sample.so
    install -Dm755 linked-client $out/bin/sqlite3-extension-runtime-client
    install -Dm644 ${../sdk/LICENSE.MIT} \
      $out/share/licenses/sqlite3-extension-runtime/LICENSE.MIT
    cp -rL ${sqlite3-dynamic}/share/licenses/sqlite3-dynamic \
      $out/share/licenses/sqlite3-extension-runtime/

    mkdir -p $buildMaterials/share/sqlite3-extension-runtime-materials
    cp ${./package.nix} ${./extension.c} ${./linked-client.c} ${./runtime-test.sh} \
      ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/
    cp linked-client $buildMaterials/share/sqlite3-extension-runtime-materials/
    printf '%s\n' "$sqlite_cflags_text" \
      > $buildMaterials/share/sqlite3-extension-runtime-materials/linked-client-cflags.txt
    printf '%s\n' "$sqlite_libs_text" \
      > $buildMaterials/share/sqlite3-extension-runtime-materials/linked-client-libs.txt
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/dynamic-sdk
    ln -s ${sqlite3-dynamic.buildMaterials} \
      $buildMaterials/share/sqlite3-extension-runtime-materials/sqlite3-dynamic
    runHook postInstall
  '';

  meta.license = with lib.licenses; [
    mit
    publicDomain
  ];
  passthru.apk.license = "MIT AND blessing AND Apache-2.0 WITH LLVM-exception";
  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "sqlite3-extension-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        sqlite3-dynamic
        finalAttrs.finalPackage
      ];
      files = {
        "/plugins/sample.so" = "${finalAttrs.finalPackage}/lib/sample.so";
      };
    };
  }
  // extraChecks;
})
