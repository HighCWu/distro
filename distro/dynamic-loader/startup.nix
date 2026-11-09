# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  llvm-toolchain,
  sysroot,
  execution,
  exportedLibc,
  exportedCxx,
}:
let
  materials = pkgs.runCommand "dynamic-startup-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes
    cp ${./startup.nix} $out/recipes/startup.nix
    cp ${./linux-shared.patch} $out/recipes/linux-shared.patch
    cp ${./wasm-pic-eh-context.patch} $out/recipes/wasm-pic-eh-context.patch
    ln -s ${sysroot} $out/original-sysroot
    ln -s ${execution} $out/execution
    ln -s ${exportedLibc} $out/exported-libc
    ln -s ${exportedCxx} $out/exported-cxx
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
    ln -s ${exportedCxx}/libcxx-exports.a $out/lib/libcxx-exports.a

    # The Linux driver selects crt1 only for an executable and surrounds it
    # with --whole-archive. Keep the original CRT object intact: a relocatable
    # link would discard Wasm export_name aliases used by startup callbacks.
    # Execution adapters live in libc-exports.a as ordinary runtime helpers.
    llvm-ar -M <<EOF
    CREATE $out/lib/crt1.o
    ADDMOD ${sysroot}/lib/crt1.o
    SAVE
    END
    EOF
  ''
