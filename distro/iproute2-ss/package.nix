# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  sdk-fork-continuation,
  src ? pkgs.fetchurl {
    url = "https://mirrors.edge.kernel.org/pub/linux/utils/net/iproute2/iproute2-7.3.0.tar.xz";
    hash = "sha256-XBeJ0pC7oEimE17Rq4GwQC3Q+1KNHxQhdlxCsfw9Yok=";
  },
}:
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "iproute2-ss";
  version = "7.3.0";
  inherit src;
  dontFixup = true;
  nativeBuildInputs = [
    sdk-fork-continuation
    llvm-toolchain
    pkgs.pkg-config
    pkgs.bison
    pkgs.flex
    pkgs.nodejs
  ];
  configurePhase = ''
    runHook preConfigure
    # The unchanged libutil sources include ordinary fork(). Use its existing
    # opt-in C execution profile, not private prototypes or an application patch.
    export CC=wasm-linux-fork-cc AR=llvm-ar YACC=bison
    export HOSTCC=${pkgs.stdenv.cc}/bin/cc
    sh configure --prefix=/ --libdir=/lib --libbpf_force=off
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    # Both directories consume upstream Makefile variables and targets.
    make -j$NIX_BUILD_CORES CC=wasm-linux-fork-cc AR=llvm-ar SHARED_LIBS=n SUBDIRS=lib
    make -j$NIX_BUILD_CORES CC=wasm-linux-fork-cc AR=llvm-ar SHARED_LIBS=n SUBDIRS=misc TARGETS=ss
    wasm-linux-fork-finalize misc/ss ss.wasm
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      ss.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 ss.wasm $out/sbin/ss
    notices=$out/share/licenses/iproute2-ss
    install -Dm644 COPYING "$notices/COPYING"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    mkdir -p $out/share/iproute2-ss-materials
    cp config.mk ${./package.nix} $out/share/iproute2-ss-materials/
    runHook postInstall
  '';
  meta = {
    description = "Unmodified iproute2 ss and libutil/libnetlink, using the opt-in static C execution profile; not the full iproute2 suite";
    license = lib.licenses.gpl2Only;
  };
  passthru.sourceBundle = pkgs.runCommand "iproute2-ss-${finalAttrs.version}-source" { } ''
    mkdir "$out"
    cp ${src} "$out/iproute2-7.3.0.tar.xz"
    cp ${./package.nix} "$out/package.nix"
    cp ${./source.README.md} "$out/README.md"
    ln -s ${sdk-fork-continuation.buildMaterials} "$out/sdk-build-materials"
    (cd ${finalAttrs.finalPackage} && sha256sum sbin/ss) > "$out/BINARY_SHA256SUMS"
    (cd "$out" && sha256sum iproute2-7.3.0.tar.xz package.nix README.md > SHA256SUMS)
    (cd "$out" && sha256sum --check SHA256SUMS)
    (cd ${finalAttrs.finalPackage} && sha256sum --check "$out/BINARY_SHA256SUMS")
  '';
})
