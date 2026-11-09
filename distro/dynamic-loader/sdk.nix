# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  musl,
  sysroot-base,
  sysroot,
  llvm-toolchain,
  llvm-runtimes,
  sdk,
  sharedCompiler ? null,
}:
let
  dynamicRuntimes = llvm-runtimes.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./wasm-pic-eh-context.patch ];
  });
  compiler =
    if sharedCompiler == null then
      llvm-toolchain.override { llvm-runtimes = dynamicRuntimes; }
    else
      llvm-toolchain.override {
        llvm-runtimes = dynamicRuntimes;
        llvm-toolchain-unwrapped = sharedCompiler;
      };
  configSiteFiles = pkgs.writeTextDir "share/linux-wasm-dynamic-sdk/config.site" (
    builtins.readFile ./config.site
  );
  configSite = "${configSiteFiles}/share/linux-wasm-dynamic-sdk/config.site";
  dynamicMusl = musl.override { enableDynamicLoader = true; };
  dynamicBase = sysroot-base.override { musl = dynamicMusl; };
  dynamicRoot = sysroot.override {
    llvm-runtimes = dynamicRuntimes;
    sysroot-base = dynamicBase;
  };
  linkerConfigArgs = [
    "--import-memory"
    "--max-memory=${toString platform.maximumMemoryBytes}"
    "--shared-memory"
    "--growable-table"
    "--export=__stack_pointer"
    "--export-all"
    "-z"
    "stack-size=8388608"
  ];
  # Export static bounds so main-module address metadata can cover interiors.
  executableLinkerArgs = linkerConfigArgs ++ [
    "--export=__global_base"
    "--export=__data_end"
  ];
  linkRoot = import ../sdk/link-sysroot.nix {
    inherit pkgs lib;
    sysroot = dynamicRoot;
    name = "dynamic-link-sysroot-${platform.wasmArch}";
    executableArgs = executableLinkerArgs;
    sharedArgs = linkerConfigArgs;
    cxxArgs = [ ];
  };
  exportedLibc =
    pkgs.runCommand "dynamic-libc-${platform.wasmArch}"
      {
        nativeBuildInputs = [ compiler ];
      }
      ''
        mkdir $out
        cp ${dynamicRoot}/lib/libc.a $out/libc-exports.a
        chmod u+w $out/libc-exports.a
        # Keep libc fallback definitions weak only in this export archive.
        llvm-objcopy --weaken $out/libc-exports.a $out/libc-exports-weakened.a
        mv $out/libc-exports-weakened.a $out/libc-exports.a
        # These weak startup adapters form a lazy chain selected by main's signature.
        # Keep them in the normal libc archive, outside the forced export set.
        llvm-ar d $out/libc-exports.a __main_void.o __main_argc_argv.o
        # Keep execution adapters available to links that omit CRT startup.
        llvm-ar r $out/libc-exports.a ${execution}/dynamic-execution.o
      '';
  exportedCxx =
    pkgs.runCommand "dynamic-libcxx-${platform.wasmArch}"
      {
        nativeBuildInputs = [ compiler ];
      }
      ''
        mkdir $out
        for archive in \
          ${dynamicRoot}/lib/libc++.a \
          ${dynamicRoot}/lib/libc++abi.a \
          ${dynamicRoot}/lib/libunwind.a; do
          test -s "$archive"
        done
        llvm-ar -M <<EOF
        CREATE $out/libcxx-exports.a
        ADDLIB ${dynamicRoot}/lib/libc++.a
        ADDLIB ${dynamicRoot}/lib/libc++abi.a
        ADDLIB ${dynamicRoot}/lib/libunwind.a
        SAVE
        END
        EOF
        test -s $out/libcxx-exports.a
        llvm-ar t $out/libcxx-exports.a > $out/libcxx-export-members.txt
        test -s $out/libcxx-export-members.txt
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
      platform
      execution
      exportedLibc
      exportedCxx
      ;
    llvm-toolchain = compiler;
    sysroot = linkRoot;
  };
  configFlags = [
    "--target=${platform.targetTriple}"
    "--sysroot=${startupRoot}"
  ]
  ++ platform.compilerFlags;
  config = pkgs.writeText "dynamic-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg configFlags + "\n"
  );
  cxxConfig = pkgs.writeText "dynamic-cxx-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      configFlags
      ++ [
        "-stdlib=libc++"
        "$--unwindlib=libunwind"
        "-fwasm-exceptions"
        "-fc++-abi=webassembly"
      ]
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
  cxx = pkgs.writeShellApplication {
    name = "wasm-linux-dlopen-c++";
    text =
      builtins.replaceStrings
        [ "@compiler@" "@configArgument@" ]
        [
          (lib.escapeShellArg "${compiler}/bin/clang++")
          (lib.escapeShellArgs [
            "--no-default-config"
            "--config=${cxxConfig}"
          ])
        ]
        (builtins.readFile ../sdk/compiler.sh);
  };
  materials = pkgs.runCommand "dynamic-sdk-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/dynamic-loader
    mkdir -p $out/recipes/sdk
    cp ${../sdk/link-sysroot.nix} $out/recipes/sdk/link-sysroot.nix
    cp -r ${../musl} $out/recipes/musl
    cp ${config} $out/recipes/compiler.cfg
    cp ${cxxConfig} $out/recipes/compiler-cxx.cfg
    cp ${../sdk/LICENSE.MIT} $out/licenses/SDK-MIT.txt
    cp ${dynamicMusl.src}/COPYRIGHT $out/licenses/musl-COPYRIGHT
    ln -s ${sdk.buildMaterials} $out/default-sdk-materials
    ln -s ${linkRoot} $out/link-sysroot
    ln -s ${startupRoot} $out/startup-sysroot
    ln -s ${startupRoot.buildMaterials} $out/startup-materials
    ln -s ${exportedCxx} $out/exported-cxx
    ln -s ${compiler} $out/compiler
    ln -s ${compiler.licenseSource} $out/compiler-source
  '';
in
pkgs.symlinkJoin {
  name = "linux-wasm-dynamic-sdk-${platform.wasmArch}";
  paths = [
    cc
    cxx
    configSiteFiles
  ];
  postBuild = ''
    mkdir -p $out/share/linux-wasm-dynamic-sdk
    cp ${./SDK.md} $out/share/linux-wasm-dynamic-sdk/README.md
    ln -s ${materials} $out/share/linux-wasm-dynamic-sdk/build-materials
  '';
  passthru = {
    sysroot = startupRoot;
    buildMaterials = materials;
    inherit
      config
      configSite
      execution
      compiler
      cxxConfig
      exportedCxx
      linkRoot
      ;
    checks.driver =
      pkgs.runCommand "dynamic-sdk-driver-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          nativeBuildInputs = [ pkgs.nodejs ];
        }
        ''
          DYNAMIC_SDK_CC=${cc}/bin/wasm-linux-dlopen-cc \
            DYNAMIC_SDK_CXX=${cxx}/bin/wasm-linux-dlopen-c++ \
            DYNAMIC_SDK_CXX_ARCHIVE=${startupRoot}/lib/libcxx-exports.a \
            DYNAMIC_SDK_AR=${compiler}/bin/llvm-ar \
            node --test ${./sdk-driver.test.js}
          touch $out
        '';
  };
}
