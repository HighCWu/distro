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
  enableCooperativePoll ? false,
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
  # Instrument only applications and shared objects. The dynamic libc,
  # startup objects, and compiler runtimes remain outside this profile.
  cooperativeExecution =
    if enableCooperativePoll then
      import ./cooperative-execution.nix {
        inherit pkgs lib platform;
        llvm-toolchain = compiler;
        sysroot = dynamicRoot;
      }
    else
      null;
  cooperativePollCompilerFlags = lib.optional enableCooperativePoll "-fsanitize-coverage=trace-pc,no-prune,edge";
  linkerConfigArgs = [
    "--import-memory"
    "--max-memory=${toString platform.maximumMemoryBytes}"
    "--shared-memory"
    # ThinLTO postpones the setjmp/longjmp rewrite until the final link.
    "--mllvm=-wasm-enable-sjlj"
    "--growable-table"
    "--export-all"
    "-z"
    "stack-size=8388608"
  ];
  # Main modules require the stack pointer for the runtime signal ABI. Shared
  # modules may be stackless, so export it only when the linker defines it.
  # Export static bounds so main-module address metadata can cover interiors.
  executableLinkerArgs =
    linkerConfigArgs
    ++ [
      "--export=__stack_pointer"
      "--export=__global_base"
      "--export=__data_end"
    ]
    ++ lib.optionals enableCooperativePoll [
      "--export=__sanitizer_cov_trace_pc"
      "--export=__wasm_user_poll_abi"
      "--export=__tls_base"
      "${cooperativeExecution}/cooperative-execution.o"
    ];
  sharedLinkerArgs = linkerConfigArgs ++ [ "--export-if-defined=__stack_pointer" ];
  linkRoot = import ../sdk/link-sysroot.nix {
    inherit pkgs lib;
    sysroot = dynamicRoot;
    name = "dynamic-link-sysroot-${platform.wasmArch}";
    executableArgs = executableLinkerArgs;
    sharedArgs = sharedLinkerArgs;
    cxxArgs = [ ];
  };
  exportedLibc =
    pkgs.runCommand "dynamic-libc-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          compiler
          pkgs.python3
        ];
      }
      ''
        mkdir $out
        cp ${dynamicRoot}/lib/libc.a $out/libc-exports.a
        chmod u+w $out/libc-exports.a
        # Keep hidden allocator internals strong so malloc and free share the
        # implementation selected by musl's original weak/strong aliases.
        test -x ${compiler}/bin/llvm-readobj
        test -x ${compiler}/bin/llvm-nm
        test -x ${compiler}/bin/llvm-ranlib
        python3 ${./weaken-public-symbols.py} \
          ${compiler}/bin/llvm-readobj $out/libc-exports.a ${platform.wasmArch} \
          > $out/libc-export-symbols.txt
        llvm-objcopy --weaken-symbols=$out/libc-export-symbols.txt \
          $out/libc-exports.a $out/libc-exports-weakened.a
        mv $out/libc-exports-weakened.a $out/libc-exports.a
        # These weak startup adapters form a lazy chain selected by main's signature.
        # Keep them in the normal libc archive, outside the forced export set.
        llvm-ar d $out/libc-exports.a __main_void.o __main_argc_argv.o
        # Keep execution adapters available to links that omit CRT startup.
        llvm-ar r $out/libc-exports.a ${execution}/dynamic-execution.o
        # Rebuild the archive map after objcopy and member changes.
        llvm-ranlib $out/libc-exports.a
        llvm-nm --extern-only --defined-only --format=posix \
          $out/libc-exports.a > $out/libc-export-index-check.txt
        awk '
          $1 == "__libc_malloc_impl" && $2 == "T" { mallocng = 1 }
          $1 == "__libc_malloc_impl" && $2 == "W" { fallback = 1 }
          $1 == "__libc_malloc" && $2 == "T" { malloc_entry = 1 }
          $1 == "__libc_free" && $2 == "T" { free_impl = 1 }
          $1 == "malloc" && $2 == "W" { public_malloc = 1 }
          $1 == "free" && $2 == "W" { public_free = 1 }
          END {
            if (!mallocng || !fallback || !malloc_entry || !free_impl ||
                !public_malloc || !public_free) exit 1
          }
        ' $out/libc-export-index-check.txt || {
          echo "dynamic libc: allocator internal/public symbol bindings changed" >&2
          exit 1
        }
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
  ++ platform.compilerFlags
  ++ cooperativePollCompilerFlags;
  profileSuffix = lib.optionalString enableCooperativePoll "-cooperative-poll";
  config = pkgs.writeText "dynamic-${platform.wasmArch}${profileSuffix}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg configFlags + "\n"
  );
  cxxConfig = pkgs.writeText "dynamic-cxx-${platform.wasmArch}${profileSuffix}.cfg" (
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
  importStub = pkgs.writeShellApplication {
    name = "wasm-linux-write-import-stub";
    text =
      builtins.replaceStrings
        [ "@python@" "@helper@" ]
        [
          (lib.escapeShellArg "${pkgs.python3}/bin/python3")
          (lib.escapeShellArg "${../sdk/write-import-stub.py}")
        ]
        (builtins.readFile ../sdk/write-import-stub.sh);
  };
  materials = pkgs.runCommand "dynamic-sdk-materials-${platform.wasmArch}" { } ''
    mkdir -p $out/recipes $out/licenses
    cp -r ${./.} $out/recipes/dynamic-loader
    mkdir -p $out/recipes/sdk
    cp ${../sdk/link-sysroot.nix} $out/recipes/sdk/link-sysroot.nix
    cp ${../sdk/write-import-stub.py} $out/recipes/sdk/write-import-stub.py
    cp ${../sdk/write-import-stub.sh} $out/recipes/sdk/write-import-stub.sh
    cp ${../sdk/write-import-stub.test.py} $out/recipes/sdk/write-import-stub.test.py
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
  name = "linux-wasm-dynamic-sdk-${platform.wasmArch}${profileSuffix}";
  paths = [
    cc
    cxx
    importStub
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
    cooperativePoll = enableCooperativePoll;
    cooperativePollScope =
      if enableCooperativePoll then
        "applications and shared objects; libc, startup objects and compiler runtimes are uninstrumented"
      else
        "disabled";
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
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.python3
          ];
        }
        ''
          DYNAMIC_SDK_CC=${cc}/bin/wasm-linux-dlopen-cc \
            DYNAMIC_SDK_CXX=${cxx}/bin/wasm-linux-dlopen-c++ \
            DYNAMIC_SDK_CXX_ARCHIVE=${startupRoot}/lib/libcxx-exports.a \
            DYNAMIC_SDK_AR=${compiler}/bin/llvm-ar \
            node --test ${./sdk-driver.test.js}
          SDK_CC=${compiler}/bin/clang \
            SDK_LD=${compiler}/bin/wasm-ld \
            SDK_IMPORT_STUB=${importStub}/bin/wasm-linux-write-import-stub \
            python3 ${../sdk}/write-import-stub.test.py
          touch $out
        '';
  };
}
