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
  libraryCoverage ? false,
  automaticFinalize ? false,
  routedBrk ? false,
  cxxExceptions ? false,
}:
assert !libraryCoverage || cooperativePoll;
assert !cxxExceptions || (automaticFinalize && !cooperativePoll && !routedBrk);
let
  profileSuffix =
    lib.optionalString cooperativePoll "-poll"
    + lib.optionalString libraryCoverage "-libc"
    + lib.optionalString automaticFinalize "-auto"
    + lib.optionalString routedBrk "-brk"
    + lib.optionalString cxxExceptions "-cxx";
  profileCompilerFlags =
    platform.compilerFlags
    ++ lib.optionals automaticFinalize [
      "--wasm-fork-asyncify"
      "-B${pkgs.binaryen}/bin"
    ]
    ++ lib.optional cooperativePoll "-fsanitize-coverage=trace-pc,no-prune,edge";
  forkMusl = musl.override {
    enableForkContinuation = true;
    enableCooperativePoll = libraryCoverage;
    enableBrkSyscall = routedBrk;
  };
  forkBase = sysroot-base.override { musl = forkMusl; };
  forkRoot = sysroot.override { sysroot-base = forkBase; };
  configSite = pkgs.writeText "fork-${platform.wasmArch}${profileSuffix}-config.site" (
    builtins.readFile ../config.site + "\n" + builtins.readFile ./config.site
  );
  # Execution-state support is not a musl implementation detail. Other libc
  # ports and raw syscall callers can link the same object and use this ABI.
  execution =
    pkgs.runCommand "fork-execution-${platform.wasmArch}${profileSuffix}"
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
          ${lib.optionalString libraryCoverage "-DWASM_FORK_POLL_LIBC=1"} \
          ${lib.optionalString cxxExceptions "-DWASM_FORK_CXX=1"} \
          -O2 -Wall -Wextra -Werror -c ${./execution.c} -o $out/fork-execution.o
        ${lib.optionalString cooperativePoll ''
          clang ${lib.escapeShellArgs ([ "--target=${platform.targetTriple}" ] ++ platform.compilerFlags)} \
            ${lib.optionalString libraryCoverage "-DWASM_POLL_THREAD_GLOBAL=1"} \
            -O2 -Wall -Wextra -Werror -c ${../cooperative-poll/execution.c} -o $out/user-poll.o
        ''}
      '';
  linkRoot = import ../sdk/link-sysroot.nix {
    inherit pkgs lib;
    sysroot = forkRoot;
    name = "fork-${platform.wasmArch}${profileSuffix}";
    executableArgs = [
      "${execution}/fork-execution.o"
    ]
    ++ lib.optional cxxExceptions "${cxxState}/cxx-state.o"
    ++ lib.optionals cxxExceptions [
      "-lc++"
      "-lc++abi"
      "-lunwind"
    ]
    ++ lib.optional cooperativePoll "${execution}/user-poll.o"
    ++ platform.linkerFlags
    ++ lib.optionals routedBrk [
      "--undefined=__wasm_brk_layout_v1"
      "--undefined=__wasm_brk_update_v1"
    ]
    ++ [
      "--export=__stack_pointer"
      "--export=__tls_base"
      "--undefined=__wasm_fork_abi"
    ]
    ++ lib.optional cooperativePoll "--export=__wasm_user_poll_abi";
  };
  cxxState =
    if cxxExceptions then
      pkgs.runCommand "fork-cxx-state-${platform.wasmArch}${profileSuffix}"
        {
          nativeBuildInputs = [ llvm-toolchain ];
        }
        ''
          mkdir $out
          clang++ ${
            lib.escapeShellArgs (
              [
                "--target=${platform.targetTriple}"
                "--sysroot=${forkRoot}"
              ]
              ++ platform.compilerFlags
            )
          } -std=c++17 -O2 -Wall -Wextra -Werror -c ${./cxx-state.cc} -o $out/cxx-state.o
        ''
    else
      null;
  config = pkgs.writeText "fork-${platform.wasmArch}${profileSuffix}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${linkRoot}"
      ]
      ++ profileCompilerFlags
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
  cxx =
    if cxxExceptions then
      pkgs.writeShellApplication {
        name = "wasm-linux-fork-c++";
        text =
          builtins.replaceStrings
            [ "@compiler@" "@configArgument@" ]
            [
              (lib.escapeShellArg "${llvm-toolchain}/bin/clang++")
              (lib.escapeShellArg "--config=${config}")
            ]
            (builtins.readFile ../sdk/compiler.sh);
      }
    else
      null;
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
      profile =
        if cxxExceptions then
          "experimental-static-cxx-fork-candidate-v1"
        else
          "experimental-static-c-fork-v1";
      applicationPolling = cooperativePoll;
      inherit (platform) addressBits targetTriple;
      defaultSdkUnchanged = true;
      automaticFinalization = automaticFinalize;
      libraryPolling = libraryCoverage;
      syscallBrk = routedBrk;
      userPollAbi =
        if libraryCoverage then
          2
        else if cooperativePoll then
          1
        else
          null;
      requiresFinalization = !automaticFinalize;
      syscallContinuationAbi = if cxxExceptions then 3 else 2;
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
      limitations =
        if cxxExceptions then
          [
            "static single-module C++"
            "single-thread fork only"
            "no dynamic linking"
            "no SjLj exception support"
            "fork only outside an active C++ exception"
          ]
        else
          [
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
      }
      // lib.optionalAttrs cxxExceptions {
        cxxStateObject = "${cxxState}/cxx-state.o";
        cxxCompiler = "${cxx}/bin/wasm-linux-fork-c++";
      };
    }
  );
  muslProfile = pkgs.writeText "fork-musl-profile-${platform.wasmArch}${profileSuffix}.json" (
    builtins.toJSON {
      source = builtins.baseNameOf (toString forkMusl.src);
      patches = map (patch: builtins.baseNameOf (toString patch)) forkMusl.patches;
      enableForkContinuation = true;
      enableCooperativePoll = libraryCoverage;
      enableBrkSyscall = routedBrk;
    }
  );
  materials = pkgs.runCommand "fork-sdk-materials-${platform.wasmArch}${profileSuffix}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/fork-continuation
    cp -r ${../musl} $out/recipes/musl
    ${lib.optionalString cooperativePoll "cp -r ${../cooperative-poll} $out/recipes/cooperative-poll"}
    cp ${../sdk/compiler.sh} $out/recipes/compiler.sh
    cp ${config} $out/recipes/compiler.cfg
    cp ${muslProfile} $out/recipes/fork-musl-profile.json
    cp ${../config.site} $out/recipes/config.site
    cp ${configSite} $out/recipes/fork-config.site
    ln -s ${linkRoot} $out/actualsysroot
    ln -s ${forkMusl.src} $out/fork-musl-source
    cp ${pkgs.binaryen.src}/LICENSE $out/licenses/Binaryen-LICENSE
    cp ${../sdk/LICENSE.MIT} $out/licenses/SDK-MIT.txt
    ${lib.optionalString cxxExceptions ''
      mkdir -p $out/licenses/cxx
      cp ${forkRoot.licenseSources.llvm-runtimes}/libcxx/LICENSE.TXT $out/licenses/cxx/libcxx-LICENSE.TXT
      cp ${forkRoot.licenseSources.llvm-runtimes}/libcxxabi/LICENSE.TXT $out/licenses/cxx/libcxxabi-LICENSE.TXT
      cp ${forkRoot.licenseSources.llvm-runtimes}/libunwind/LICENSE.TXT $out/licenses/cxx/libunwind-LICENSE.TXT
      cp ${forkRoot.licenseSources.llvm-runtimes}/compiler-rt/LICENSE.TXT $out/licenses/cxx/compiler-rt-LICENSE.TXT
      cp ${cxxState}/cxx-state.o $out/recipes/cxx-state.o
      cp ${llvm-toolchain}/bin/clang++.cfg $out/recipes/clang++.cfg
      ln -s ${forkRoot.licenseSources.llvm-runtimes} $out/llvm-runtimes-source
    ''}
    ln -s ${pkgs.binaryen.src} $out/binaryen-source
    ln -s ${sdk.buildMaterials} $out/default-sdk-build-materials
    ln -s ${sdk.sourceBundle} $out/default-sdk-selected-sources
  '';
in
pkgs.symlinkJoin {
  name = "linux-wasm-fork-sdk-${platform.wasmArch}${profileSuffix}";
  paths = [
    cc
    finalize
    metadata
  ]
  ++ lib.optional cxxExceptions cxx;
  postBuild = ''
    mkdir -p $out/share/linux-wasm-fork-sdk
    ln -s ${materials} $out/share/linux-wasm-fork-sdk/build-materials
    cp ${./SDK.md} $out/share/linux-wasm-fork-sdk/README.md
    cp ${configSite} $out/share/linux-wasm-fork-sdk/config.site
  '';
  passthru = {
    inherit configSite;
    compilerFlags = profileCompilerFlags;
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
          mkdir -p distro/fork-continuation distro/cooperative-poll packages/kernel/src
          cp ${../../package.json} package.json
          cp ${../../packages/kernel/package.json} packages/kernel/package.json
          cp ${./sdk.test.js} distro/fork-continuation/sdk.test.js
          cp ${./finalize.sh} distro/fork-continuation/finalize.sh
          cp ${./package.nix} distro/fork-continuation/package.nix
          cp ${./sdk.nix} distro/fork-continuation/sdk.nix
          cp ${./execution.c} distro/fork-continuation/execution.c
          cp ${./cxx-state.cc} distro/fork-continuation/cxx-state.cc
          cp ${../cooperative-poll/execution.c} distro/cooperative-poll/execution.c
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
