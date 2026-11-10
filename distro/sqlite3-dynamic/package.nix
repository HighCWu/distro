# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sqlite3,
  sdk,
  sdk-dynamic-loader,
  llvm-toolchain,
  llvm-runtimes,
}:
let
  configureArgs = [
    "--build=${pkgs.stdenv.buildPlatform.config}"
    "--host=${platform.targetTriple}"
    "--prefix=/"
    "--disable-shared"
    "--disable-readline"
    # Upstream makes this a fatal configure error if the target compiler cannot
    # really compile and link a dlopen() call. Do not cache or bypass that test.
    "--enable-load-extension"
  ];
  configureArgsText = lib.escapeShellArgs configureArgs;
  sourceTree = sqlite3.src;
  materialDir = "$buildMaterials/share/sqlite3-dynamic-materials";
  cflags = "-O2 -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "sqlite3-dynamic";
  inherit (sqlite3) version;
  src = sourceTree;
  outputs = [
    "out"
    "buildMaterials"
  ];

  # SQLite's configure script uses its own native Tcl-compatible helper when
  # tclsh is unavailable; this compiler is only for that build-time helper.
  depsBuildBuild = [ pkgs.stdenv.cc ];
  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.gnumake
    pkgs.nodejs
  ];

  dontFixup = true;
  dontStrip = true;

  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${lib.escapeShellArg sdk-dynamic-loader.configSite} \
      CC=wasm-linux-dlopen-cc \
      CC_FOR_BUILD=${pkgs.stdenv.cc}/bin/cc \
      BUILD_CC=${pkgs.stdenv.cc}/bin/cc \
      CFLAGS=${lib.escapeShellArg cflags} \
      AR=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-ar"} \
      RANLIB=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-ranlib"} \
      NM=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-nm"} \
      LD=${lib.escapeShellArg "${llvm-toolchain}/bin/wasm-ld"} \
      ./configure ${configureArgsText}
    runHook postConfigure
  '';

  postConfigure = ''
    # This header is written from the actual target compiler/linker probe.
    grep -qx '#define HAVE_DLOPEN 1' sqlite_cfg.h
    if grep -q 'SQLITE_OMIT_LOAD_EXTENSION' Makefile sqlite_cfg.h; then
      echo "SQLite configure disabled loadable extensions" >&2
      exit 1
    fi
    grep -qx 'ENABLE_STATIC_SHELL = 1' Makefile
    grep -qx 'ENABLE_LIB_SHARED = 0' Makefile
    grep -Eq '^OPT_FEATURE_FLAGS = .*SQLITE_OMIT_WAL=1' Makefile
    grep -Eq '^CFLAGS = .*SQLITE_MAX_MMAP_SIZE=0' Makefile
  '';

  buildPhase = ''
    runHook preBuild
    make -j"''${NIX_BUILD_CORES:-1}" sqlite3 libsqlite3.a
    test -s sqlite3
    test -s libsqlite3.a
    test -s sqlite3.pc
    grep -qx 'prefix=/' sqlite3.pc
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      sqlite3 ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p \
      "$out/bin" \
      "$out/include" \
      "$out/lib" \
      "$out/lib/pkgconfig" \
      "$out/share/licenses/sqlite3-dynamic/sqlite" \
      ${materialDir}

    install -m755 sqlite3 "$out/bin/sqlite3"
    install -m644 libsqlite3.a "$out/lib/libsqlite3.a"
    install -m644 sqlite3.pc "$out/lib/pkgconfig/sqlite3.pc"
    install -m644 ${sourceTree}/sqlite3.h "$out/include/sqlite3.h"
    install -m644 ${sourceTree}/sqlite3ext.h "$out/include/sqlite3ext.h"

    # SQLite ships its public-domain blessing in these original headers rather
    # than in a top-level LICENSE/COPYING file.
    install -m644 ${sourceTree}/sqlite3.h \
      "$out/share/licenses/sqlite3-dynamic/sqlite/sqlite3.h"
    install -m644 ${sourceTree}/sqlite3ext.h \
      "$out/share/licenses/sqlite3-dynamic/sqlite/sqlite3ext.h"
    install -Dm644 ${../sdk/LICENSE.MIT} \
      "$out/share/licenses/sqlite3-dynamic/LOCAL-ADDITIONS.MIT"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses \
      "$out/share/licenses/sqlite3-dynamic/standard-sdk"
    cp -rL ${sdk-dynamic-loader.buildMaterials}/licenses \
      "$out/share/licenses/sqlite3-dynamic/dynamic-sdk"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/llvm/LICENSE.TXT \
      "$out/share/licenses/sqlite3-dynamic/LLVM-LICENSE.TXT"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/clang/LICENSE.TXT \
      "$out/share/licenses/sqlite3-dynamic/Clang-LICENSE.TXT"
    install -Dm644 ${sdk-dynamic-loader.compiler.licenseSource}/lld/LICENSE.TXT \
      "$out/share/licenses/sqlite3-dynamic/LLD-LICENSE.TXT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$out/share/licenses/sqlite3-dynamic/compiler-rt-LICENSE.TXT"

    # sqlite3.src is the same fixed fetchzip source used by the existing
    # sqlite3 package. Preserve the source and target configuration with output.
    ln -s ${sourceTree} "${materialDir}/source-tree"
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      "${materialDir}/dynamic-sdk"
    ln -s ${sdk-dynamic-loader.compiler.licenseSource} \
      "${materialDir}/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} \
      "${materialDir}/llvm-runtimes-source"
    cp ${sdk-dynamic-loader.configSite} \
      "${materialDir}/config.site"
    cp config.log sqlite_cfg.h Makefile libsqlite3.a sqlite3 sqlite3.pc \
      ${./package.nix} ${../busybox/check-binary.mjs} \
      ${../../packages/kernel/src/wasm_binary.ts} \
      "${materialDir}/"
    cp -rL ${sdk}/share/linux-wasm-sdk/licenses \
      "${materialDir}/standard-sdk-licenses"
    cp -rL ${sdk-dynamic-loader.buildMaterials}/licenses \
      "${materialDir}/dynamic-sdk-licenses"
    cat > "${materialDir}/build-parameters.txt" <<EOF
    source=SQLite ${sqlite3.version}; inherited from sqlite3.src
    source-tree=${sourceTree}
    CC=wasm-linux-dlopen-cc
    CFLAGS=${cflags}
    LD=${llvm-toolchain}/bin/wasm-ld
    AR=${llvm-toolchain}/bin/llvm-ar
    RANLIB=${llvm-toolchain}/bin/llvm-ranlib
    NM=${llvm-toolchain}/bin/llvm-nm
    CONFIG_SITE=${sdk-dynamic-loader.configSite}
    configure=./configure ${configureArgsText}
    build=make -j$NIX_BUILD_CORES sqlite3 libsqlite3.a
    load-extension=enabled by the upstream target dlopen compile/link probe
    EOF
    runHook postInstall
  '';

  meta = {
    description = "SQLite CLI and static library with dlopen-based extension loading for Linux/Wasm";
    homepage = "https://sqlite.org/";
    license = lib.licenses.publicDomain;
  };
  passthru.apk.license = "blessing AND MIT AND Apache-2.0 WITH LLVM-exception";
}
