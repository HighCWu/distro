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
  linkRoot = import ../sdk/link-sysroot.nix {
    inherit pkgs lib;
    sysroot = forkRoot;
    name = "fork-${platform.wasmArch}${lib.optionalString cooperativePoll "-poll"}";
    executableArgs = [
      "${execution}/fork-execution.o"
    ]
    ++ lib.optional cooperativePoll "${execution}/user-poll.o"
    ++ platform.linkerFlags
    ++ [
      "--export=__stack_pointer"
      "--export=__tls_base"
      "--undefined=__wasm_fork_abi"
    ]
    ++ lib.optional cooperativePoll "--export=__wasm_user_poll_abi";
  };
  config = pkgs.writeText "fork-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${linkRoot}"
      ]
      ++ platform.compilerFlags
      ++ lib.optional cooperativePoll "-fsanitize-coverage=trace-pc,no-prune,edge"
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
        "CLONE_IO"
      ];
      cloneNamespaceTransport = true;
      cloneParentTransport = true;
      cloneUntracedTransport = true;
      clonePtraceTransport = true;
      legacyCloneExitSignalTransport = true;
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
        sysroot = "${linkRoot}";
        sourceSysroot = "${forkRoot}";
        executableResponse = "${linkRoot}/lib/wasm-linux-executable.rsp";
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
    ln -s ${linkRoot} $out/actualsysroot
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
    sysroot = linkRoot;
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
          mkdir -p distro/fork-continuation packages/kernel/src
          cp ${../../package.json} package.json
          cp ${../../packages/kernel/package.json} packages/kernel/package.json
          cp ${./sdk.test.js} distro/fork-continuation/sdk.test.js
          cp ${./finalize.sh} distro/fork-continuation/finalize.sh
          cp ${./package.nix} distro/fork-continuation/package.nix
          cp ${./sdk.nix} distro/fork-continuation/sdk.nix
          cp ${./execution.c} distro/fork-continuation/execution.c
          cp ${./raw-clone.c} distro/fork-continuation/raw-clone.c
          cp ${./config.site} distro/fork-continuation/config.site
          cp ${../config.site} distro/config.site
          cp ${./execution-link.test.js} distro/fork-continuation/execution-link.test.js
          cp ${../../packages/kernel/src/user-functions.ts} packages/kernel/src/user-functions.ts
          cp ${../../packages/kernel/src/wasm_binary.ts} packages/kernel/src/wasm_binary.ts
          cp ${../default.nix} distro/default.nix
          node --test distro/fork-continuation/sdk.test.js
          FORK_LINK_CLANG=${lib.escapeShellArg "${llvm-toolchain}/bin/clang"} node --test distro/fork-continuation/execution-link.test.js
          grep -F -- ${lib.escapeShellArg "${execution}/fork-execution.o"} ${linkRoot}/lib/wasm-linux-executable.rsp
          ${lib.optionalString cooperativePoll ''
            grep -F -- ${lib.escapeShellArg "${execution}/user-poll.o"} ${linkRoot}/lib/wasm-linux-executable.rsp
          ''}
          mkdir $out
        '';
  };
}
