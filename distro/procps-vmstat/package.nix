# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  platform,
  musl,
  llvm-runtimes,
  src ? pkgs.fetchurl {
    url = "mirror://sourceforge/procps-ng/Production/procps-ng-4.0.7.tar.xz";
    hash = "sha256-nSAh9HpFAcZnhiyZQqktGVNpSyHRG80XAug+tZTj1n0=";
  },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "procps-vmstat";
  version = "4.0.7";
  inherit src;
  dontDisableStatic = true;
  # AC_FUNC_MALLOC/REALLOC cannot execute their zero-size probes while
  # cross compiling. musl mallocng allocates size class zero; realloc(NULL, 0)
  # delegates to malloc(0). The installed VM-events consumer checks both on
  # the target; these are behavior answers, not added replacement functions.
  env.ac_cv_func_malloc_0_nonnull = "yes";
  env.ac_cv_func_realloc_0_nonnull = "yes";
  meta = {
    license = [
      lib.licenses.lgpl21Plus
      lib.licenses.gpl2Plus
    ];
    outputsToInstall = [ "out" ];
    description = "Unmodified procps-ng vmstat and its static libproc2 dependency, not the full utility suite";
  };
  nativeBuildInputs = [
    pkgs.pkg-config
    pkgs.nodejs
  ];
  configureFlags = [
    "--disable-shared"
    "--enable-static"
    "--disable-nls"
    "--without-ncurses"
    "--without-systemd"
    "--without-elogind"
    "--disable-numa"
    "--disable-pidwait"
  ];
  # Build the real upstream executable and library, without private function
  # substitutes, a new libc wrapper, or changes to the upstream C sources.
  buildFlags = [ "src/vmstat" ];
  installPhase = ''
    runHook preInstall
    install -Dm755 src/vmstat $out/bin/vmstat
    notices=$out/share/licenses/procps-vmstat
    install -Dm644 COPYING "$notices/COPYING"
    install -Dm644 COPYING.LIB "$notices/COPYING.LIB"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  postFixup = ''
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      $out/bin/vmstat ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
  '';
  # Hash only after the binary derivation has completed strip/fixup. Do not
  # capture an intermediate binary from inside its postFixup hook.
  passthru.sourceBundle =
    pkgs.runCommand "procps-vmstat-${finalAttrs.version}-source"
      {
        allowedReferences = [ ];
      }
      ''
        mkdir "$out"
        cp ${src} "$out/procps-ng-4.0.7.tar.xz"
        cp ${./package.nix} "$out/package.nix"
        cp ${./source.README.md} "$out/README.md"
        (cd ${finalAttrs.finalPackage} && sha256sum bin/vmstat) > "$out/BINARY_SHA256SUMS"
        (cd "$out" && sha256sum procps-ng-4.0.7.tar.xz package.nix README.md > SHA256SUMS)
        (cd "$out" && sha256sum --check SHA256SUMS)
        (cd ${finalAttrs.finalPackage} && sha256sum --check "$out/BINARY_SHA256SUMS")
      '';
})
