# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-dynamic-loader,
  llvm-toolchain,
}:
let
  version = "2.5.4";
  src = import ./source.nix { inherit pkgs; };
  configureArgs = [
    "--build=${pkgs.stdenv.buildPlatform.config}"
    "--host=${platform.targetTriple}"
    "--prefix=/"
    "--disable-shared"
    "--enable-static"
    "--enable-ltdl-install"
  ];
  configureArgsText = lib.escapeShellArgs configureArgs;
  archive = "libltdl/.libs/libltdl.a";
  materialDir = "$buildMaterials/share/libltdl-materials";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "libltdl";
  inherit version src;
  outputs = [
    "out"
    "buildMaterials"
  ];

  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.gnumake
    pkgs.m4
  ];

  dontFixup = true;
  dontStrip = true;

  preConfigure = ''
    # Pin hashes for the unmodified upstream C sources whose compilation and
    # static loader inclusion define this output.
    sha256sum \
      libltdl/ltdl.c \
      libltdl/lt_dlloader.c \
      libltdl/lt_error.c \
      libltdl/loaders/dlopen.c \
      > "$NIX_BUILD_TOP/libltdl-source.sha256s"
  '';

  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${lib.escapeShellArg sdk-dynamic-loader.configSite} \
      CC=wasm-linux-dlopen-cc \
      AR=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-ar"} \
      RANLIB=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-ranlib"} \
      NM=${lib.escapeShellArg "${llvm-toolchain}/bin/llvm-nm"} \
      LD=${lib.escapeShellArg "${llvm-toolchain}/bin/wasm-ld"} \
      ./configure ${configureArgsText}
    runHook postConfigure
  '';

  postConfigure = ''
    # Do not silently build a preopen-only libltdl if the Wasm toolchain's
    # ordinary link probes fail to find its real dlopen backend.
    grep -Eq '^LT_DLLOADERS = .*libltdl/dlopen\.la([[:space:]]|$)' Makefile
    grep -Eq '^LT_DLPREOPEN = .*dlpreopen libltdl/dlopen\.la' Makefile
    grep -qx '#define HAVE_DLFCN_H 1' config.h
    grep -qx '#define HAVE_LIBDLLOADER 1' config.h
    grep -qx '#define LT_DLSEARCH_PATH "/lib:/usr/lib"' config.h
  '';

  buildPhase = ''
    runHook preBuild
    # The upstream all target builds BUILT_SOURCES before the library objects,
    # including libltdl/libltdl/lt__argz.h when the configure probe requires it.
    make -j"$NIX_BUILD_CORES" all
    sha256sum --check "$NIX_BUILD_TOP/libltdl-source.sha256s"

    ${llvm-toolchain}/bin/llvm-ar t ${archive} > "$NIX_BUILD_TOP/libltdl-archive-members.txt"
    grep -qi 'dlopen' "$NIX_BUILD_TOP/libltdl-archive-members.txt"
    ${llvm-toolchain}/bin/llvm-nm --defined-only ${archive} > "$NIX_BUILD_TOP/libltdl-symbols.txt"
    grep -q 'dlopen_LTX_get_vtable' "$NIX_BUILD_TOP/libltdl-symbols.txt"
    runHook postBuild
  '';

  installPhase = ''
        runHook preInstall
        mkdir -p \
          $out/include/libltdl \
          $out/lib \
          $out/share/licenses/libltdl \
          ${materialDir}

        install -m644 ${archive} $out/lib/libltdl.a
        install -m644 libltdl/ltdl.h $out/include/ltdl.h
        install -m644 \
          libltdl/libltdl/lt_system.h \
          libltdl/libltdl/lt_error.h \
          libltdl/libltdl/lt_dlloader.h \
          $out/include/libltdl/

        # Keep both the libtool distribution notice and libltdl's LGPL text as
        # shipped by GNU, with their original names and contents.
        install -m644 COPYING $out/share/licenses/libltdl/COPYING
        install -m644 libltdl/COPYING.LIB $out/share/licenses/libltdl/COPYING.LIB

        ln -s ${src} ${materialDir}/source.tar.xz
        ln -s ${sdk-dynamic-loader.buildMaterials} ${materialDir}/sdk
        cp ${sdk-dynamic-loader.configSite} ${materialDir}/config.site
        cp config.log config.h config.status Makefile \
          ${materialDir}/
        cp "$NIX_BUILD_TOP/libltdl-source.sha256s" \
          "$NIX_BUILD_TOP/libltdl-archive-members.txt" \
          "$NIX_BUILD_TOP/libltdl-symbols.txt" \
          ${materialDir}/
    (cd ${materialDir} && sha256sum source.tar.xz > source.sha256)
        cp ${./package.nix} ${./source.nix} ${materialDir}/
        cat > ${materialDir}/build-parameters.txt <<EOF
    source=GNU libtool ${version}; source hash recorded in source.sha256
    CC=wasm-linux-dlopen-cc
    LD=${llvm-toolchain}/bin/wasm-ld
    AR=${llvm-toolchain}/bin/llvm-ar
    RANLIB=${llvm-toolchain}/bin/llvm-ranlib
    NM=${llvm-toolchain}/bin/llvm-nm
    CONFIG_SITE=${sdk-dynamic-loader.configSite}
    configure=./configure ${configureArgsText}
    build=make -j$NIX_BUILD_CORES all
    backend=LT_DLLOADERS and LT_DLPREOPEN include libltdl/dlopen.la
    EOF
        runHook postInstall
  '';

  meta = {
    description = "GNU libltdl static library for Linux/Wasm";
    homepage = "https://www.gnu.org/software/libtool/";
    license = lib.licenses.lgpl2Plus;
  };
}
