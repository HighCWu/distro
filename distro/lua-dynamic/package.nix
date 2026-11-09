# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  lua,
  sdk-dynamic-loader,
  llvm-toolchain,
  musl,
  llvm-runtimes,
}:
pkgs.stdenvNoCC.mkDerivation {
  pname = "lua-dynamic";
  inherit (lua) version src;
  outputs = [
    "out"
    "dev"
    "buildMaterials"
  ];
  dontFixup = true;
  moveToDev = false;
  nativeBuildInputs = [
    sdk-dynamic-loader
    llvm-toolchain
    pkgs.nodejs
  ];

  buildPhase = ''
    runHook preBuild
    make -j"''${NIX_BUILD_CORES:-1}" linux \
      CC=wasm-linux-dlopen-cc \
      AR='llvm-ar rcu' \
      RANLIB=llvm-ranlib
    runHook postBuild
  '';

  postBuild = ''
    for program in src/lua src/luac; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$program" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
  '';

  installPhase = ''
    runHook preInstall
    make install \
      INSTALL_TOP="$out" \
      INSTALL_INC="$dev/include" \
      INSTALL_LIB="$dev/lib" \
      INSTALL_LMOD="$out/usr/share/lua/5.4" \
      INSTALL_CMOD="$out/usr/lib/lua/5.4" \
      CC=wasm-linux-dlopen-cc \
      AR='llvm-ar rcu' \
      RANLIB=llvm-ranlib

    for artifact in "$out/bin/lua" "$out/bin/luac" "$dev/include/lua.h" "$dev/lib/liblua.a"; do
      test -s "$artifact" || {
        echo "Lua dynamic install missing $artifact" >&2
        exit 1
      }
    done

    notices=$out/share/licenses/lua-dynamic
    mkdir -p "$notices" $dev/share/licenses/lua-dynamic \
      $buildMaterials/share/lua-dynamic-materials
    # The upstream license is distributed as this complete HTML notice.
    cp doc/readme.html "$notices/lua-readme.html"
    cp ${sdk-dynamic-loader.buildMaterials}/licenses/SDK-MIT.txt "$notices/SDK-MIT.txt"
    cp ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    cp -r "$notices"/. $dev/share/licenses/lua-dynamic/

    cp ${./package.nix} $buildMaterials/share/lua-dynamic-materials/
    cp doc/readme.html $buildMaterials/share/lua-dynamic-materials/lua-readme.html
    cp src/Makefile $buildMaterials/share/lua-dynamic-materials/Makefile
    llvm-ar t "$dev/lib/liblua.a" \
      > $buildMaterials/share/lua-dynamic-materials/liblua-members.txt
    cat > $buildMaterials/share/lua-dynamic-materials/build-parameters.txt <<EOF
    source=Lua ${lua.version}; reused lua.src
    source-tree=${lua.src}
    CC=wasm-linux-dlopen-cc
    AR=llvm-ar rcu
    RANLIB=llvm-ranlib
    build=make -j$NIX_BUILD_CORES linux
    install=make install INSTALL_TOP=$out INSTALL_INC=$dev/include INSTALL_LIB=$dev/lib
    EOF
    ln -s ${lua.src} $buildMaterials/share/lua-dynamic-materials/source-tree
    ln -s ${sdk-dynamic-loader.buildMaterials} \
      $buildMaterials/share/lua-dynamic-materials/dynamic-sdk
    ln -s ${musl.src} $buildMaterials/share/lua-dynamic-materials/musl-source
    ln -s ${llvm-runtimes.src} $buildMaterials/share/lua-dynamic-materials/llvm-runtimes-source
    runHook postInstall
  '';

  meta = {
    description = "Lua 5.4 with the standard POSIX dynamic module loader enabled";
    license = lib.licenses.mit;
    outputsToInstall = [ "out" ];
  };
  passthru.apk.license = "MIT AND Apache-2.0 WITH LLVM-exception";
}
