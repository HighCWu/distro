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
  forkMusl = musl.override { enableForkContinuation = true; };
  forkBase = sysroot-base.override { musl = forkMusl; };
  forkRoot = sysroot.override { sysroot-base = forkBase; };
  # Execution-state support is not a musl implementation detail. Other libc
  # ports and raw syscall callers can link the same object and use this ABI.
  execution =
    pkgs.runCommand "fork-execution-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
      }
      ''
        mkdir $out
        clang ${
          lib.escapeShellArgs (
            [
              "--target=${platform.targetTriple}"
              "--sysroot=${sysroot}"
            ]
            ++ platform.compilerFlags
          )
        } -O2 -Wall -Wextra -Werror -c ${./execution.c} -o $out/fork-execution.o
      '';
  config = pkgs.writeText "fork-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${forkRoot}"
      ]
      ++ platform.compilerFlags
      ++ [ "$${execution}/fork-execution.o" ]
      ++ map (flag: "$-Wl,${flag}") (
        platform.linkerFlags
        ++ [
          "--export=__stack_pointer"
          "--export=__tls_base"
          "--undefined=__wasm_fork_abi"
        ]
      )
    )
    + "\n"
  );
  cc = pkgs.writeShellApplication {
    name = "wasm-linux-fork-cc";
    text =
      builtins.replaceStrings
        [ "@compiler@" "@configArgument@" ]
        [
          (lib.escapeShellArg "${llvm-toolchain}/bin/clang")
          (lib.escapeShellArg "--config=${config}")
        ]
        (builtins.readFile ../sdk/compiler.sh);
  };
  finalize = pkgs.writeShellApplication {
    name = "wasm-linux-fork-finalize";
    runtimeInputs = [ pkgs.coreutils ];
    text =
      builtins.replaceStrings [ "@wasmOpt@" ] [ (lib.escapeShellArg "${pkgs.binaryen}/bin/wasm-opt") ]
        (builtins.readFile ./finalize.sh);
  };
  metadata = pkgs.writeTextDir "share/linux-wasm-fork-sdk/profile.json" (
    builtins.toJSON {
      schemaVersion = 1;
      profile = "experimental-static-c-fork-v1";
      inherit (platform) addressBits targetTriple;
      defaultSdkUnchanged = true;
      requiresFinalization = true;
      syscallContinuationAbi = 1;
      syscallImport = "linux.syscall_v2";
      callbackCloneImport = "linux.syscall";
      binaryenVersion = pkgs.binaryen.version;
      continuationBufferBytes = 262144;
      overflowBehavior = "trap";
      limitations = [
        "static C"
        "single-thread fork only"
        "no dynamic linking"
        "no C++ EH/SjLj"
      ];
      paths = {
        sysroot = "${forkRoot}";
        compilerConfiguration = "${config}";
        executionObject = "${execution}/fork-execution.o";
      };
    }
  );
  materials = pkgs.runCommand "fork-sdk-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/fork-continuation
    cp -r ${../musl} $out/recipes/musl
    cp ${../sdk/compiler.sh} $out/recipes/compiler.sh
    cp ${config} $out/recipes/compiler.cfg
    cp ${pkgs.binaryen.src}/LICENSE $out/licenses/Binaryen-LICENSE
    cp ${../sdk/LICENSE.MIT} $out/licenses/SDK-MIT.txt
    ln -s ${pkgs.binaryen.src} $out/binaryen-source
    ln -s ${sdk.buildMaterials} $out/default-sdk-build-materials
    ln -s ${sdk.sourceBundle} $out/default-sdk-selected-sources
  '';
in
pkgs.symlinkJoin {
  name = "linux-wasm-fork-sdk-${platform.wasmArch}";
  paths = [
    cc
    finalize
    metadata
  ];
  postBuild = ''
    mkdir -p $out/share/linux-wasm-fork-sdk
    ln -s ${materials} $out/share/linux-wasm-fork-sdk/build-materials
    cp ${./SDK.md} $out/share/linux-wasm-fork-sdk/README.md
  '';
  passthru = {
    sysroot = forkRoot;
    buildMaterials = materials;
    checks.wrapper =
      pkgs.runCommand "fork-sdk-wrapper-contract"
        {
          nativeBuildInputs = [ pkgs.nodejs ];
        }
        ''
          mkdir fork-continuation
          cp ${./sdk.test.js} fork-continuation/sdk.test.js
          cp ${./finalize.sh} fork-continuation/finalize.sh
          cp ${./package.nix} fork-continuation/package.nix
          cp ${../default.nix} default.nix
          node --test fork-continuation/sdk.test.js
          mkdir $out
        '';
  };
}
