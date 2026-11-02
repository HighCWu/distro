# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  musl,
  sysroot-base,
  sysroot,
  llvm-toolchain,
  sdk,
}:
let
  dynamicMusl = musl.override { enableDynamicLoader = true; };
  dynamicBase = sysroot-base.override { musl = dynamicMusl; };
  dynamicRoot = sysroot.override { sysroot-base = dynamicBase; };
  execution =
    pkgs.runCommand "dynamic-execution-${platform.wasmArch}" { nativeBuildInputs = [ llvm-toolchain ]; }
      ''
        mkdir $out
        clang ${
          lib.escapeShellArgs (
            [
              "--target=${platform.targetTriple}"
              "--sysroot=${dynamicRoot}"
            ]
            ++ platform.compilerFlags
          )
        } \
          -O2 -Wall -Wextra -Werror -c ${./execution.c} -o $out/dynamic-execution.o
      '';
  config = pkgs.writeText "dynamic-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${dynamicRoot}"
      ]
      ++ platform.compilerFlags
      ++ [
        ("$" + "${execution}/dynamic-execution.o")
        "$-Wl,--whole-archive"
        "$-lc"
        "$-Wl,--no-whole-archive"
      ]
      ++ map (flag: "$-Wl,${flag}") (
        platform.linkerFlags
        ++ [
          "--growable-table"
          "--export-all"
        ]
      )
    )
    + "\n"
  );
  cc = pkgs.writeShellApplication {
    name = "wasm-linux-dlopen-cc";
    text =
      builtins.replaceStrings
        [ "@compiler@" "@configArgument@" ]
        [
          (lib.escapeShellArg "${llvm-toolchain}/bin/clang")
          (lib.escapeShellArg "--config=${config}")
        ]
        (builtins.readFile ../sdk/compiler.sh);
  };
  materials = pkgs.runCommand "dynamic-sdk-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/dynamic-loader
    cp -r ${../musl} $out/recipes/musl
    cp ${config} $out/recipes/compiler.cfg
    cp ${../sdk/LICENSE.MIT} $out/licenses/SDK-MIT.txt
    cp ${dynamicMusl.src}/COPYRIGHT $out/licenses/musl-COPYRIGHT
    ln -s ${sdk.buildMaterials} $out/default-sdk-materials
  '';
in
pkgs.symlinkJoin {
  name = "linux-wasm-dynamic-sdk-${platform.wasmArch}";
  paths = [ cc ];
  postBuild = ''
    mkdir -p $out/share/linux-wasm-dynamic-sdk
    cp ${./SDK.md} $out/share/linux-wasm-dynamic-sdk/README.md
    ln -s ${materials} $out/share/linux-wasm-dynamic-sdk/build-materials
  '';
  passthru = {
    sysroot = dynamicRoot;
    buildMaterials = materials;
    inherit config execution;
  };
}
