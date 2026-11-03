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
  cooperativePoll ? false,
}:
let
  forkMusl = musl.override { enableForkContinuation = true; };
  forkBase = sysroot-base.override { musl = forkMusl; };
  forkRoot = sysroot.override { sysroot-base = forkBase; };
  configSite = pkgs.writeText "fork-${platform.wasmArch}-config.site" (
    builtins.readFile ../config.site + "\n" + builtins.readFile ./config.site
  );
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
        } ${lib.optionalString cooperativePoll "-DWASM_FORK_USER_POLL=1"} \
          -O2 -Wall -Wextra -Werror -c ${./execution.c} -o $out/fork-execution.o
        ${lib.optionalString cooperativePoll ''
          clang ${lib.escapeShellArgs ([ "--target=${platform.targetTriple}" ] ++ platform.compilerFlags)} \
            -O2 -Wall -Wextra -Werror -c ${../cooperative-poll/execution.c} -o $out/user-poll.o
        ''}
      '';
  config = pkgs.writeText "fork-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${forkRoot}"
      ]
      ++ platform.compilerFlags
      ++ [ ("$" + "${execution}/fork-execution.o") ]
      ++ lib.optionals cooperativePoll [
        "-fsanitize-coverage=trace-pc,no-prune,edge"
        ("$" + "${execution}/user-poll.o")
      ]
      ++ map (flag: "$-Wl,${flag}") (
        platform.linkerFlags
        ++ [
          "--export=__stack_pointer"
          "--export=__tls_base"
          "--undefined=__wasm_fork_abi"
        ]
        ++ lib.optional cooperativePoll "--export=__wasm_user_poll_abi"
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
      applicationPolling = cooperativePoll;
      inherit (platform) addressBits targetTriple;
      defaultSdkUnchanged = true;
      requiresFinalization = true;
      syscallContinuationAbi = 2;
      syscallImport = "linux.syscall_v2";
      callbackCloneImport = "linux.syscall";
      clone3ForkSubset = true;
      clone3NamespaceTransport = true;
      cloneResourceSharingFlags = [
        "CLONE_FS"
        "CLONE_FILES"
        "CLONE_SYSVSEM"
      ];
      cloneNamespaceTransport = true;
      cloneParentTransport = true;
      nativeClone3Transport = true;
      clone3WideFlags = [
        "CLONE_CLEAR_SIGHAND"
        "CLONE_NNP"
        "CLONE_AUTOREAP"
        "CLONE_PIDFD_AUTOKILL"
        "CLONE_EMPTY_MNTNS"
      ];
      clone3ExitSignal = {
        minimum = 0;
        maximum = 64;
        requiresNativeTransport = true;
      };
      clone3NativeOnlyFlags = [
        "CLONE_NEWTIME"
        "CLONE_INTO_CGROUP"
      ];
      clone3PidSelection = {
        maximumCount = 32;
        elementBits = 32;
        signed = true;
        requiresNativeTransport = true;
      };
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
        configSite = "${configSite}";
      };
    }
  );
  materials = pkgs.runCommand "fork-sdk-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/fork-continuation
    cp -r ${../musl} $out/recipes/musl
    ${lib.optionalString cooperativePoll "cp -r ${../cooperative-poll} $out/recipes/cooperative-poll"}
    cp ${../sdk/compiler.sh} $out/recipes/compiler.sh
    cp ${config} $out/recipes/compiler.cfg
    cp ${../config.site} $out/recipes/config.site
    cp ${configSite} $out/recipes/fork-config.site
    cp ${pkgs.binaryen.src}/LICENSE $out/licenses/Binaryen-LICENSE
    cp ${../sdk/LICENSE.MIT} $out/licenses/SDK-MIT.txt
    ln -s ${pkgs.binaryen.src} $out/binaryen-source
    ln -s ${sdk.buildMaterials} $out/default-sdk-build-materials
    ln -s ${sdk.sourceBundle} $out/default-sdk-selected-sources
  '';
in
pkgs.symlinkJoin {
  name = "linux-wasm-fork-sdk-${platform.wasmArch}${lib.optionalString cooperativePoll "-poll"}";
  paths = [
    cc
    finalize
    metadata
  ];
  postBuild = ''
    mkdir -p $out/share/linux-wasm-fork-sdk
    ln -s ${materials} $out/share/linux-wasm-fork-sdk/build-materials
    cp ${./SDK.md} $out/share/linux-wasm-fork-sdk/README.md
    cp ${configSite} $out/share/linux-wasm-fork-sdk/config.site
  '';
  passthru = {
    inherit configSite;
    sysroot = forkRoot;
    buildMaterials = materials;
    checks.wrapper =
      pkgs.runCommand "fork-sdk-wrapper-contract"
        {
          nativeBuildInputs = [
            pkgs.nodejs
            llvm-toolchain
          ];
        }
        ''
          mkdir fork-continuation
          cp ${./sdk.test.js} fork-continuation/sdk.test.js
          cp ${./finalize.sh} fork-continuation/finalize.sh
          cp ${./package.nix} fork-continuation/package.nix
          cp ${./sdk.nix} fork-continuation/sdk.nix
          cp ${./execution.c} fork-continuation/execution.c
          cp ${./raw-clone.c} fork-continuation/raw-clone.c
          cp ${./config.site} fork-continuation/config.site
          cp ${../config.site} config.site
          cp ${./execution-link.test.js} fork-continuation/execution-link.test.js
          cp ${../default.nix} default.nix
          node --test fork-continuation/sdk.test.js
          node --test fork-continuation/execution-link.test.js
          grep -F -- ${lib.escapeShellArg ("$" + "${execution}/fork-execution.o")} ${config}
          mkdir $out
        '';
  };
}
