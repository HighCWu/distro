# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  util-linux,
  llvm-toolchain,
  sdk-fork-continuation,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "util-linux-setsid-standard-fork";
  inherit (util-linux) version src;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-continuation
    llvm-toolchain
    pkgs.pkg-config
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    CONFIG_SITE=${sdk-fork-continuation.configSite} CC=wasm-linux-fork-cc \
      AR=llvm-ar RANLIB=llvm-ranlib CFLAGS='-O2' ./configure \
      --build=${pkgs.stdenv.buildPlatform.config} --host=${platform.targetTriple} \
      --prefix=/ --disable-shared --enable-static --disable-nls \
      --disable-all-programs --enable-setsid \
      --without-systemd --without-udev --without-python --without-cap-ng \
      --without-selinux --without-audit --without-ncurses --without-ncursesw \
      --without-readline
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmp ${util-linux.src}/sys-utils/setsid.c sys-utils/setsid.c
    make -j$NIX_BUILD_CORES setsid
    cmp ${util-linux.src}/sys-utils/setsid.c sys-utils/setsid.c
    sha256sum sys-utils/setsid.c > setsid-source.sha256
    wasm-linux-fork-finalize setsid setsid.wasm
    wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o verify.linked
    wasm-linux-fork-finalize verify.linked verify.wasm
    for binary in setsid.wasm verify.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 setsid.wasm $out/bin/setsid
    install -Dm755 verify.wasm $out/libexec/setsid-fork/verify
    mkdir -p $out/share/licenses/setsid-fork $out/share/setsid-fork-materials
    cp -r COPYING Documentation/licenses $out/share/licenses/setsid-fork/
    install -Dm644 ${../sdk/LICENSE.MIT} $out/share/licenses/setsid-fork/LOCAL-ADDITIONS.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/setsid-fork/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/setsid-fork/compiler-rt-LICENSE.TXT
    cp config.h config.log setsid-source.sha256 ${./package.nix} ${./runtime.c} \
      $out/share/setsid-fork-materials/
    ln -s $src $out/share/setsid-fork-materials/source
    ln -s ${sdk-fork-continuation.buildMaterials} $out/share/setsid-fork-materials/sdk
    runHook postInstall
  '';
  meta = {
    description = "Unpatched util-linux setsid using standard fork, opt-in static C execution";
    license = with lib.licenses; [
      gpl2Plus
      bsd3
      mit
    ];
  };
  # Use the real program instead of the overlapping BusyBox applet in this
  # opt-in image, following the existing util-linux package's payload policy.
  passthru.apk.replaces = [ "busybox" ];
  passthru.checks.runtime = vm-test.installedTest {
    name = "setsid-standard-fork-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
    cpus = 2;
  };
})
