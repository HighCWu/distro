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
  sharedCompiler ? null,
}:
let
  compiler =
    if sharedCompiler == null then
      llvm-toolchain
    else
      llvm-toolchain.override { llvm-toolchain-unwrapped = sharedCompiler; };
  dynamicMusl = musl.override { enableDynamicLoader = true; };
  dynamicBase = sysroot-base.override { musl = dynamicMusl; };
  dynamicRoot = sysroot.override { sysroot-base = dynamicBase; };
  exportedLibc =
    pkgs.runCommand "dynamic-libc-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
      }
      ''
        mkdir $out
        cp ${dynamicRoot}/lib/libc.a $out/libc-exports.a
        chmod u+w $out/libc-exports.a
        # These weak startup adapters form a lazy chain selected by main's signature.
        # Keep them in the normal libc archive, outside the forced export set.
        llvm-ar d $out/libc-exports.a __main_void.o __main_argc_argv.o
      '';
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
  startupRoot = import ./startup.nix {
    inherit
      pkgs
      lib
      platform
      execution
      exportedLibc
      ;
    llvm-toolchain = compiler;
    sysroot = dynamicRoot;
  };
  config = pkgs.writeText "dynamic-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${startupRoot}"
      ]
      ++ platform.compilerFlags
      ++ map (flag: "$-Wl,${flag}") ([
        "--import-memory"
        "--max-memory=${toString platform.maximumMemoryBytes}"
        "--shared-memory"
        "--export=__stack_pointer"
        "--growable-table"
        "--export-all"
        "-z"
        "stack-size=8388608"
      ])
    )
    + "\n"
  );
  cc = pkgs.writeShellApplication {
    name = "wasm-linux-dlopen-cc";
    text =
      builtins.replaceStrings
        [ "@compiler@" "@configArgument@" ]
        [
          (lib.escapeShellArg "${compiler}/bin/clang")
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
    ln -s ${startupRoot} $out/startup-sysroot
    ln -s ${startupRoot.buildMaterials} $out/startup-materials
    ln -s ${compiler} $out/compiler
    ln -s ${compiler.licenseSource} $out/compiler-source
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
    sysroot = startupRoot;
    buildMaterials = materials;
    inherit config execution compiler;
    checks.driver =
      pkgs.runCommand "dynamic-sdk-driver-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          nativeBuildInputs = [ pkgs.nodejs ];
        }
        ''
          DYNAMIC_SDK_CC=${cc}/bin/wasm-linux-dlopen-cc \
            node --test ${./sdk-driver.test.js}
          touch $out
        '';
  };
}
