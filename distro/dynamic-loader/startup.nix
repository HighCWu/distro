# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  execution,
  exportedLibc,
}:
let
  materials = pkgs.runCommand "dynamic-startup-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes
    cp ${./startup.nix} $out/recipes/startup.nix
    cp ${./linux-shared.patch} $out/recipes/linux-shared.patch
    ln -s ${sysroot} $out/original-sysroot
    ln -s ${execution} $out/execution
    ln -s ${exportedLibc} $out/exported-libc
  '';
in
pkgs.runCommand "dynamic-startup-sysroot-${platform.wasmArch}"
  {
    nativeBuildInputs = [ llvm-toolchain ];
    passthru = {
      buildMaterials = materials;
      licenseSources = sysroot.licenseSources or { };
    };
  }
  ''
    mkdir -p $out
    cp -rs ${sysroot}/. $out/
    chmod u+w $out/lib
    rm $out/lib/crt1.o
    ln -s ${exportedLibc}/libc-exports.a $out/lib/libc-exports.a

    # The Linux driver selects crt1 only for an executable and surrounds it
    # with --whole-archive. Keep each original object intact: a relocatable
    # link would discard Wasm export_name aliases used by execution callbacks.
    llvm-ar -M <<EOF
    CREATE $out/lib/crt1.o
    ADDMOD ${sysroot}/lib/crt1.o
    ADDMOD ${execution}/dynamic-execution.o
    SAVE
    END
    EOF
  ''
