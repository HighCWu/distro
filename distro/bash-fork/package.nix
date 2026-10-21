# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  bash,
  llvm-toolchain,
  sdk-fork-continuation,
  busybox,
  vm-test,
}:
let
  # Isolate the execution-ABI prerequisite from the larger Bash build, so a
  # Bash configure failure cannot hide the SjLj/continuation result.
  sjlj =
    pkgs.runCommand "fork-sjlj-${platform.wasmArch}"
      {
        nativeBuildInputs = [ sdk-fork-continuation ];
      }
      ''
        mkdir $out
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./sjlj.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/probe.wasm
      '';
  candidate = pkgs.stdenvNoCC.mkDerivation {
    pname = "bash-standard-fork-candidate";
    inherit (bash) version src;
    nativeBuildInputs = [ sdk-fork-continuation ];
    CC_FOR_BUILD = "${pkgs.stdenv.cc}/bin/cc";
    CFLAGS_FOR_BUILD = "-std=gnu17";
    AR = "${llvm-toolchain}/bin/llvm-ar";
    RANLIB = "${llvm-toolchain}/bin/llvm-ranlib";
    prePatch = ''
      for patch in ${toString bash.gnuPatches}; do
        patch -p0 < "$patch"
      done
    '';
    # Only the existing declaration fix, not the default Bash callback port.
    patches = [ ../bash/wasm-anonfile.patch ];
    configurePhase = ''
      runHook preConfigure
      CONFIG_SITE=${../config.site} CC=wasm-linux-fork-cc \
        CFLAGS='-O2 -std=gnu17 -mllvm -wasm-enable-sjlj' ./configure \
        --build=${pkgs.stdenv.buildPlatform.config} --host=${platform.targetTriple} \
        --prefix=/ --enable-static-link --disable-readline --disable-nls \
        --without-bash-malloc \
        bash_cv_job_control_missing=present bash_cv_sys_named_pipes=present \
        bash_cv_getcwd_malloc=yes bash_cv_getenv_redef=yes \
        bash_cv_func_sigsetjmp=present bash_cv_dev_fd=standard \
        bash_cv_pgrp_pipe=no bash_cv_wexitstatus_offset=8 \
        bash_cv_unusable_rtsigs=no bash_cv_printf_a_format=yes \
        bash_cv_wcontinued_broken=no
      runHook postConfigure
    '';
    buildPhase = ''
      runHook preBuild
      make -j$NIX_BUILD_CORES
      wasm-linux-fork-finalize bash bash.wasm
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin $out/share/licenses/bash $out/share/bash-fork-materials
      cp bash.wasm $out/bin/bash
      chmod 0755 $out/bin/bash
      cp COPYING $out/share/licenses/bash/COPYING
      cp config.h config.log ${./package.nix} ${./processes.sh} \
        ${./sjlj.c} ${./sjlj.test.js} ${./processes.test.js} \
        $out/share/bash-fork-materials/
      cp ${../bash/wasm-anonfile.patch} $out/share/bash-fork-materials/
      mkdir $out/share/bash-fork-materials/gnu-patches
      for patch in ${toString bash.gnuPatches}; do
        cp "$patch" $out/share/bash-fork-materials/gnu-patches/
      done
      ln -s $src $out/share/bash-fork-materials/source
      ln -s ${sdk-fork-continuation.buildMaterials} $out/share/bash-fork-materials/sdk
      runHook postInstall
    '';
    dontFixup = true;
    meta = {
      description = "Experimental upstream Bash standard-fork candidate; default Bash unchanged";
      license = lib.licenses.gpl3Plus;
    };
    passthru.checks = {
      host =
        pkgs.runCommand "bash-standard-fork-host"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
            BASH_FORK_HOST_CC = "${pkgs.stdenv.cc}/bin/cc";
            BASH_FORK_HOST_SHELL = "${pkgs.bash}/bin/bash";
            BASH_FORK_HOST_BUSYBOX = "${pkgs.busybox}/bin/busybox";
            BASH_FORK_HOST_FALSE = "${pkgs.coreutils}/bin/false";
          }
          ''
            node --test ${./.}/processes.test.js ${./.}/sjlj.test.js
            touch $out
          '';
      runtime = vm-test.rawInitramfsTest {
        name = "bash-standard-fork-${platform.wasmArch}";
        init = ./processes.sh;
        contents = [
          candidate
          busybox
        ];
        cpus = 2;
      };
      sjlj = vm-test.rawInitramfsTest {
        name = "fork-sjlj-${platform.wasmArch}";
        init = "${sjlj}/probe.wasm";
        cpus = 2;
      };
    };
  };
in
candidate
