# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-continuation,
  busybox,
  vm-test,
}:
let
  dash = pkgs.stdenvNoCC.mkDerivation {
    pname = "dash-fork-candidate";
    version = "0.5.13.4";
    src = pkgs.fetchurl {
      urls = [
        "https://sources.buildroot.net/dash/dash-0.5.13.4.tar.gz"
        "http://gondor.apana.org.au/~herbert/dash/files/dash-0.5.13.4.tar.gz"
      ];
      hash = "sha256-0Q39Qc2lkWVWDbOcqRXCxKdjb/8EKB2NLfd62Sx1Pis=";
    };
    nativeBuildInputs = [
      sdk-fork-continuation
      pkgs.nodejs
    ];
    DASH_HOST_SHELL = "${pkgs.dash}/bin/dash";
    DASH_HOST_BUSYBOX = "${pkgs.busybox}/bin/busybox";
    DASH_HOST_FALSE = "${pkgs.coreutils}/bin/false";
    # Native source generators must not execute target Wasm during the build.
    CC_FOR_BUILD = "${pkgs.stdenv.cc}/bin/cc";
    CFLAGS_FOR_BUILD = "-std=gnu17";
    configurePhase = ''
      runHook preConfigure
      # Dash unconditionally calls vfork. This application-only fallback is
      # explicit: it exercises ordinary fork, not shared-memory vfork semantics.
      CC=wasm-linux-fork-cc CFLAGS='-O2 -Dvfork=fork' ./configure \
        --build=${pkgs.stdenv.buildPlatform.config} \
        --host=${platform.targetTriple} --prefix=/ --enable-static --without-libedit
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      node --test ${./.}/processes.test.js
      make -j$NIX_BUILD_CORES
      wasm-linux-fork-finalize src/dash dash.wasm
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin $out/share/licenses/dash $out/share/dash-fork-materials
      cp dash.wasm $out/bin/dash
      chmod 0755 $out/bin/dash
      cp COPYING $out/share/licenses/dash/COPYING
      cp config.h config.log ${./package.nix} $out/share/dash-fork-materials/
      cp ${./processes.sh} $out/share/dash-fork-materials/processes.sh
      ln -s ${sdk-fork-continuation.buildMaterials} $out/share/dash-fork-materials/sdk
      ln -s $src $out/share/dash-fork-materials/source.tar.gz
      runHook postInstall
    '';
    # The finalizer publishes an executable Wasm module, not a host ELF binary.
    dontFixup = true;
    meta = {
      description = "Opt-in upstream Dash fork execution candidate, not the default shell";
      license = with lib.licenses; [
        bsd3
        gpl2Plus
      ];
    };
    passthru.checks = {
      host =
        pkgs.runCommand "dash-process-host"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
            DASH_HOST_SHELL = "${pkgs.dash}/bin/dash";
            DASH_HOST_BUSYBOX = "${pkgs.busybox}/bin/busybox";
            DASH_HOST_FALSE = "${pkgs.coreutils}/bin/false";
          }
          ''
            node --test ${./.}/processes.test.js
            touch $out
          '';
      runtime = vm-test.rawInitramfsTest {
        name = "dash-fork-${platform.wasmArch}";
        init = ./processes.sh;
        contents = [
          dash
          busybox
        ];
        cpus = 2;
      };
    };
  };
in
dash
