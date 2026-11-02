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
  program,
  runtimeSource,
  initSource,
}:
assert builtins.elem program [
  "setsid"
  "flock"
];
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "util-linux-${program}-standard-fork";
  inherit (util-linux) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-continuation
    llvm-toolchain
    pkgs.pkg-config
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    # These always/default-enabled upstream tools have no --enable-<name>
    # option. Keep their normal configure conditions; make selects the target.
    CONFIG_SITE=${sdk-fork-continuation.configSite} CC=wasm-linux-fork-cc \
      AR=llvm-ar RANLIB=llvm-ranlib CFLAGS='-O2' ./configure \
      --build=${pkgs.stdenv.buildPlatform.config} --host=${platform.targetTriple} \
      --prefix=/ --disable-shared --enable-static --disable-nls \
      --without-systemd --without-udev --without-python --without-cap-ng \
      --without-selinux --without-audit --without-ncurses --without-ncursesw \
      --without-readline
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmp ${util-linux.src}/sys-utils/${program}.c sys-utils/${program}.c
    make -j$NIX_BUILD_CORES ${program}
    cmp ${util-linux.src}/sys-utils/${program}.c sys-utils/${program}.c
    sha256sum sys-utils/${program}.c > program-source.sha256
    wasm-linux-fork-finalize ${program} program.wasm
    wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${runtimeSource} -o verify.linked
    wasm-linux-fork-finalize verify.linked verify.wasm
    for binary in program.wasm verify.wasm; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$binary" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 program.wasm $out/bin/${program}
    install -Dm755 verify.wasm $out/libexec/${program}-fork/verify
    mkdir -p $out/share/licenses/${program}-fork $buildMaterials/share/${program}-fork-materials
    cp -r COPYING Documentation/licenses $out/share/licenses/${program}-fork/
    install -Dm644 ${../sdk/LICENSE.MIT} $out/share/licenses/${program}-fork/LOCAL-ADDITIONS.MIT
    cp ${musl.src}/COPYRIGHT $out/share/licenses/${program}-fork/musl-COPYRIGHT
    cp ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT $out/share/licenses/${program}-fork/compiler-rt-LICENSE.TXT
    cp config.h config.log program-source.sha256 ${./package.nix} ${runtimeSource} \
      $buildMaterials/share/${program}-fork-materials/
    ln -s $src $buildMaterials/share/${program}-fork-materials/source
    ln -s ${sdk-fork-continuation.buildMaterials} $buildMaterials/share/${program}-fork-materials/sdk
    runHook postInstall
  '';
  meta = {
    description = "Unpatched util-linux ${program} using standard fork, opt-in static C execution";
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
    name = "${program}-standard-fork-${platform.wasmArch}";
    init = initSource;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
    cpus = 2;
  };
})
