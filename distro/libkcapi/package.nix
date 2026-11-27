# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  platform,
  musl,
  llvm-runtimes,
  src ? pkgs.fetchurl {
    url = "https://www.chronox.de/libkcapi/releases/1.5.1/libkcapi-1.5.1.tar.xz";
    hash = "sha256-vS5MVzE4CSKopqRcxtzgR3urAAyRcIb4AtmD1lRBWZo=";
  },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "libkcapi";
  version = "1.5.1";
  inherit src;
  dontDisableStatic = true;
  # Upstream COPYING offers BSD-3-Clause or GPLv2; retain both notices and
  # select the BSD option. The local build/ABI additions remain MIT.
  meta.license = lib.licenses.bsd3;
  patches = [ ./wasm-static-symbols.patch ];
  nativeBuildInputs = [
    pkgs.autoreconfHook
    pkgs.pkg-config
    pkgs.nodejs
  ];
  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-werror"
    "--enable-kcapi-hasher"
    "--enable-kcapi-dgstapp"
  ];
  # Build upstream tools and their library, not target documentation generators
  # which cannot execute on the build host. Application C sources are unmodified.
  buildFlags = [
    "libkcapi.la"
    "bin/kcapi-hasher"
    "bin/kcapi-dgst"
  ];
  installPhase = ''
    runHook preInstall
    install -Dm644 .libs/libkcapi.a $out/lib/libkcapi.a
    install -Dm644 lib/kcapi.h $out/include/kcapi.h
    install -Dm644 libkcapi.pc $out/lib/pkgconfig/libkcapi.pc
    for tool in kcapi-hasher kcapi-dgst; do
      install -Dm755 "bin/$tool" "$out/bin/$tool"
    done
    mkdir -p $out/libexec/libkcapi
    for name in sha224sum sha256sum sha224hmac sha256hmac; do
      ln -s ../../bin/kcapi-hasher "$out/libexec/libkcapi/$name"
    done
    notices=$out/share/licenses/libkcapi
    for notice in COPYING COPYING.bsd COPYING.gplv2; do
      install -Dm644 "$notice" "$notices/$notice"
    done
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  postFixup = ''
    for tool in kcapi-hasher kcapi-dgst; do
      node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
        "$out/bin/$tool" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    done
  '';
  passthru.sourceBundle =
    pkgs.runCommand "libkcapi-${finalAttrs.version}-source"
      {
        allowedReferences = [ ];
      }
      ''
        mkdir "$out"
        cp ${src} "$out/libkcapi-1.5.1.tar.xz"
        cp ${./wasm-static-symbols.patch} "$out/wasm-static-symbols.patch"
        cp ${./package.nix} "$out/package.nix"
        cp ${./source.README.md} "$out/README.md"
        (cd ${finalAttrs.finalPackage} && sha256sum bin/kcapi-hasher bin/kcapi-dgst) > "$out/BINARY_SHA256SUMS"
        (cd "$out" && sha256sum libkcapi-1.5.1.tar.xz wasm-static-symbols.patch package.nix README.md > SHA256SUMS)
        (cd "$out" && sha256sum --check SHA256SUMS)
        (cd ${finalAttrs.finalPackage} && sha256sum --check "$out/BINARY_SHA256SUMS")
      '';
})
