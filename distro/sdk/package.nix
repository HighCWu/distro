# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
  zlib,
  sqlite3,
}:
let
  meson = import ./meson.nix { inherit pkgs; };
  licenseTexts = import ./license-texts.nix {
    inherit pkgs lib;
    sources = sysroot.licenseSources // {
      llvm-toolchain = llvm-toolchain.licenseSource;
      meson = meson.src;
    };
  };
  profileConfig = pkgs.writeText "linux-${platform.wasmArch}.cfg" (
    lib.concatMapStringsSep "\n" lib.escapeShellArg (
      [
        "--target=${platform.targetTriple}"
        "--sysroot=${sysroot}"
      ]
      ++ platform.compilerFlags
      ++ map (flag: "$-Wl,${flag}") platform.linkerFlags
    )
    + "\n"
  );
  wrapper =
    name: compiler:
    pkgs.writeShellApplication {
      inherit name;
      text =
        builtins.replaceStrings
          [ "@compiler@" "@configArgument@" ]
          [
            (lib.escapeShellArg "${llvm-toolchain}/bin/${compiler}")
            (lib.escapeShellArg "--config=${profileConfig}")
          ]
          (builtins.readFile ./compiler.sh);
    };
  cc = wrapper "wasm-linux-cc" "clang";
  cxx = wrapper "wasm-linux-c++" "clang++";
  configSiteFiles = pkgs.writeTextDir "share/linux-wasm-sdk/config.site" (
    builtins.readFile ../config.site
  );
  pkgConfig = pkgs.writeShellApplication {
    name = "wasm-linux-pkg-config";
    text =
      builtins.replaceStrings
        [ "@sysroot@" "@libdir@" "@pkgConfig@" ]
        [
          (lib.escapeShellArg "${sysroot}")
          (lib.escapeShellArg "${sysroot}/lib/pkgconfig:${sysroot}/share/pkgconfig")
          (lib.escapeShellArg "${pkgs.pkg-config}/bin/pkg-config")
        ]
        (builtins.readFile ./pkg-config.sh);
  };
  configure = pkgs.writeShellApplication {
    name = "wasm-linux-configure";
    text =
      builtins.replaceStrings
        [
          "@cc@"
          "@cxx@"
          "@ar@"
          "@ranlib@"
          "@nm@"
          "@pkgConfig@"
          "@shell@"
          "@build@"
          "@host@"
          "@configSite@"
        ]
        (map lib.escapeShellArg [
          "${cc}/bin/wasm-linux-cc"
          "${cxx}/bin/wasm-linux-c++"
          "${llvm-toolchain}/bin/llvm-ar"
          "${llvm-toolchain}/bin/llvm-ranlib"
          "${llvm-toolchain}/bin/llvm-nm"
          "${pkgConfig}/bin/wasm-linux-pkg-config"
          "${pkgs.bash}/bin/bash"
          pkgs.stdenv.buildPlatform.config
          platform.targetTriple
          "${configSiteFiles}/share/linux-wasm-sdk/config.site"
        ])
        (builtins.readFile ./configure.sh);
  };
  cmakeToolchain = pkgs.replaceVars ./linux-wasm.cmake.in {
    inherit (platform) wasmArch;
    cc = "${cc}/bin/wasm-linux-cc";
    cxx = "${cxx}/bin/wasm-linux-c++";
    ar = "${llvm-toolchain}/bin/llvm-ar";
    ranlib = "${llvm-toolchain}/bin/llvm-ranlib";
    sysroot = "${sysroot}";
    pkgConfig = "${pkgConfig}/bin/wasm-linux-pkg-config";
  };
  cmakeFiles = pkgs.runCommand "sdk-cmake-${platform.wasmArch}" { } ''
    mkdir -p $out/share/cmake
    cp ${cmakeToolchain} $out/share/cmake/linux-wasm.cmake
  '';
  mesonCrossFile = pkgs.replaceVars ./linux-wasm.meson.in {
    inherit (platform) wasmArch;
    cc = "${cc}/bin/wasm-linux-cc";
    cxx = "${cxx}/bin/wasm-linux-c++";
    ar = "${llvm-toolchain}/bin/llvm-ar";
    strip = "${llvm-toolchain}/bin/llvm-strip";
    pkgConfig = "${pkgConfig}/bin/wasm-linux-pkg-config";
    sysroot = "${sysroot}";
  };
  mesonFiles = pkgs.runCommand "sdk-meson-${platform.wasmArch}" { } ''
    mkdir -p $out/share/meson
    cp ${mesonCrossFile} $out/share/meson/linux-wasm.ini
  '';
  profileMetadata = pkgs.writeTextDir "share/linux-wasm-sdk/profile.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform)
        addressBits
        wasmArch
        targetTriple
        compilerFlags
        linkerFlags
        ;
      cxxConfiguration = builtins.readFile ../llvm-toolchain/clang++.cfg;
      linearMemory = {
        maximumBytes = platform.maximumMemoryBytes;
      };
      paths = {
        licenseTexts = "${licenseTexts}/share/linux-wasm-sdk/licenses";
        toolchain = "${llvm-toolchain}";
        sysroot = "${sysroot}";
        compilerConfiguration = "${profileConfig}";
        configSite = "${configSiteFiles}/share/linux-wasm-sdk/config.site";
        meson = "${meson}";
      };
    }
  );
  sdkInfo = pkgs.writeShellApplication {
    name = "wasm-linux-sdk-info";
    text = ''
      if [[ $# -ne 0 ]]; then
        echo "usage: wasm-linux-sdk-info" >&2
        exit 64
      fi
      exec ${pkgs.coreutils}/bin/cat ${profileMetadata}/share/linux-wasm-sdk/profile.json
    '';
  };
  sdk = pkgs.symlinkJoin {
    name = "linux-wasm-sdk-${platform.wasmArch}";
    paths = [
      cc
      cxx
      pkgConfig
      configure
      configSiteFiles
      cmakeFiles
      mesonFiles
      profileMetadata
      sdkInfo
      licenseTexts
      llvm-toolchain
    ];
    passthru.meson = meson;
    # Reuse the exact SDK-built consumer in real-browser runtime checks.
    passthru.sqliteProgram = "${sqlitePrograms}/sdk-sqlite.wasm";
    passthru.socketProgram = "${socketPrograms}/sdk-socket.wasm";
    passthru.timeProgram = "${timePrograms}/sdk-time.wasm";
    passthru.threadTimeProgram = "${threadTimePrograms}/sdk-thread-time.wasm";
    passthru.signalWaitProgram = "${signalWaitPrograms}/sdk-signal-waits.wasm";
    passthru.signalIoProgram = "${signalIoPrograms}/sdk-signal-io.wasm";
    passthru.signalFutexProgram = "${signalFutexPrograms}/sdk-signal-futex.wasm";
    passthru.futexProgram = "${futexPrograms}/sdk-futex.wasm";
    passthru.robustMutexProgram = "${robustMutexPrograms}/sdk-robust-mutex.wasm";
    passthru.semaphoreDeadlineProgram = "${semaphoreDeadlinePrograms}/sdk-semaphore-deadline.wasm";
    passthru.filesystemProgram = "${filesystemPrograms}/sdk-filesystem.wasm";
    passthru.checks = {
      licenses = licenseTexts;
      profile = profileCheck;
      wrapper =
        pkgs.runCommand "sdk-wrapper-contract"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.pkg-config
            ];
          }
          ''
            cp ${./compiler.sh} compiler.sh
            cp ${./wrapper-test.js} wrapper-test.js
            cp ${./pkg-config.sh} pkg-config.sh
            cp ${./pkg-config-test.js} pkg-config-test.js
            node --test wrapper-test.js pkg-config-test.js
            mkdir $out
          '';
      cxx-runtime = vm-test.rawInitramfsTest {
        name = "sdk-cxx-runtime-${platform.wasmArch}";
        init = "${programs}/runtime-cxx.wasm";
        cpus = 2;
      };
      cxx-modern-eh-runtime = vm-test.rawInitramfsTest {
        name = "sdk-cxx-modern-eh-runtime-${platform.wasmArch}";
        init = "${modernEhPrograms}/runtime-cxx.wasm";
        cpus = 2;
      };
      cmake-runtime = vm-test.rawInitramfsTest {
        name = "sdk-cmake-runtime-${platform.wasmArch}";
        init = "${cmakePrograms}/sdk-example.wasm";
        cpus = 2;
      };
      zlib-runtime = vm-test.rawInitramfsTest {
        name = "sdk-zlib-runtime-${platform.wasmArch}";
        init = "${zlibPrograms}/sdk-zlib.wasm";
      };
      sqlite-runtime = vm-test.rawInitramfsTest {
        name = "sdk-sqlite-runtime-${platform.wasmArch}";
        init = "${sqlitePrograms}/sdk-sqlite.wasm";
      };
      socket-runtime = vm-test.rawInitramfsTest {
        name = "sdk-socket-runtime-${platform.wasmArch}";
        init = "${socketPrograms}/sdk-socket.wasm";
      };
      filesystem-runtime = vm-test.rawInitramfsTest {
        name = "sdk-filesystem-${platform.wasmArch}";
        init = "${filesystemPrograms}/sdk-filesystem.wasm";
      };
      time-runtime = vm-test.rawInitramfsTest {
        name = "sdk-time-runtime-${platform.wasmArch}";
        init = "${timePrograms}/sdk-time.wasm";
      };
      thread-time-runtime = vm-test.rawInitramfsTest {
        name = "sdk-thread-time-runtime-${platform.wasmArch}";
        init = "${threadTimePrograms}/sdk-thread-time.wasm";
        cpus = 2;
      };
      signal-waits-runtime = vm-test.rawInitramfsTest {
        name = "sdk-signal-waits-runtime-${platform.wasmArch}";
        init = "${signalWaitPrograms}/sdk-signal-waits.wasm";
        cpus = 2;
      };
      signal-io-runtime = vm-test.rawInitramfsTest {
        name = "sdk-signal-io-runtime-${platform.wasmArch}";
        init = "${signalIoPrograms}/sdk-signal-io.wasm";
        cpus = 2;
      };
      signal-futex-runtime = vm-test.rawInitramfsTest {
        name = "sdk-signal-futex-runtime-${platform.wasmArch}";
        init = "${signalFutexPrograms}/sdk-signal-futex.wasm";
        cpus = 2;
      };
      futex-runtime = vm-test.rawInitramfsTest {
        name = "sdk-futex-runtime-${platform.wasmArch}";
        init = "${futexPrograms}/sdk-futex.wasm";
      };
      robust-mutex-runtime = vm-test.rawInitramfsTest {
        name = "sdk-robust-mutex-runtime-${platform.wasmArch}";
        init = "${robustMutexPrograms}/sdk-robust-mutex.wasm";
        cpus = 2;
      };
      semaphore-deadline-runtime = vm-test.rawInitramfsTest {
        name = "sdk-semaphore-deadline-${platform.wasmArch}";
        init = "${semaphoreDeadlinePrograms}/sdk-semaphore-deadline.wasm";
      };
      autoconf-runtime = vm-test.rawInitramfsTest {
        name = "sdk-autoconf-runtime-${platform.wasmArch}";
        init = "${autoconfPrograms}/sdk-autoconf.wasm";
      };
      meson-runtime = vm-test.rawInitramfsTest {
        name = "sdk-meson-runtime-${platform.wasmArch}";
        init = "${mesonPrograms}/sdk-meson.wasm";
        cpus = 2;
      };
    };
  };
  profileCheck =
    pkgs.runCommand "sdk-profile-${platform.wasmArch}"
      {
        passthru.ci.heavy = true;
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
        wasm-linux-sdk-info > profile.json
        ${pkgs.diffutils}/bin/cmp profile.json ${sdk}/share/linux-wasm-sdk/profile.json
        # Verify the installed SDK view, not just the standalone bundle build.
        (
          cd ${sdk}/share/linux-wasm-sdk/licenses
          sha256sum --check SHA256SUMS
        )
        node -e '
          const fs = require("node:fs");
          const assert = require("node:assert/strict");
          const p = JSON.parse(fs.readFileSync("profile.json"));
          assert.equal(p.schemaVersion, 1);
          assert.equal(p.targetTriple, "${platform.targetTriple}");
          assert.equal(p.addressBits, ${toString platform.addressBits});
          assert.equal(p.wasmArch, "${platform.wasmArch}");
          assert.equal(p.linearMemory.maximumBytes, ${toString platform.maximumMemoryBytes});
          assert.ok(Number.isSafeInteger(p.linearMemory.maximumBytes));
          assert.ok(p.linkerFlags.includes("--max-memory=" + p.linearMemory.maximumBytes));
          assert.ok(fs.statSync(p.paths.licenseTexts + "/SHA256SUMS").isFile());
          assert.deepEqual(p.compilerFlags, ${builtins.toJSON platform.compilerFlags});
          assert.deepEqual(p.linkerFlags, ${builtins.toJSON platform.linkerFlags});
          assert.equal(p.cxxConfiguration, fs.readFileSync(p.paths.toolchain + "/bin/clang++.cfg", "utf8"));
          assert.ok(fs.statSync(p.paths.sysroot).isDirectory());
          assert.ok(fs.statSync(p.paths.meson + "/bin/meson").isFile());
          assert.ok(fs.readFileSync(p.paths.compilerConfiguration, "utf8").includes("--target=" + p.targetTriple));
          assert.equal(fs.readFileSync(p.paths.configSite, "utf8"), fs.readFileSync("${../config.site}", "utf8"));
          assert.equal(fs.readFileSync("${sdk}/share/linux-wasm-sdk/config.site", "utf8"), fs.readFileSync(p.paths.configSite, "utf8"));
        '
        info_status=0
        wasm-linux-sdk-info --unknown > invalid-profile.json 2> info-error.log || info_status=$?
        test "$info_status" -eq 64
        test ! -s invalid-profile.json
        mkdir $out
        cp profile.json $out/profile.json
      '';
  programs =
    pkgs.runCommand "sdk-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
        # Keep SDK metadata verification mandatory for the runtime consumer,
        # while allowing it to run independently without building a kernel.
        test -s ${profileCheck}/profile.json
        cp ${./compiler.sh} compiler.sh
        cp ${./config-driver-test.js} config-driver-test.js
        SDK_TEST_CLANG=${llvm-toolchain}/bin/clang \
          SDK_TEST_TARGET=${pkgs.stdenv.hostPlatform.config} node --test config-driver-test.js
        SDK_TEST_CLANG=${llvm-toolchain}/bin/clang++ \
          SDK_TEST_TARGET=${platform.targetTriple} \
          SDK_TEST_CXX_CONFIG=${llvm-toolchain}/bin/clang++.cfg \
          node --test ${./.}/exception-codegen-test.js
        mkdir $out
        # Separate compilation is part of the public consumer contract.
        # A host-style CPATH must not shadow the target C++ standard library.
        # First prove that the same pinned frontend sees the poison without
        # the SDK wrapper; this is preprocessing only, not a host target link.
        poison_status=0
        CPATH=${./host-path-poison} ${llvm-toolchain}/bin/clang++ \
          --target=${platform.targetTriple} --sysroot=${sysroot} \
          -E ${../toolchain-smoke/runtime-cxx.cc} > /dev/null 2> poison.log || poison_status=$?
        test "$poison_status" -ne 0
        grep -q SDK_HOST_INCLUDE_PATH_LEAKED poison.log
        CPATH=${./host-path-poison} CPLUS_INCLUDE_PATH=${./host-path-poison} \
          wasm-linux-c++ -std=c++17 -O2 -pthread -Werror -c ${../toolchain-smoke/runtime-cxx.cc} -o runtime.o
        wasm-linux-c++ -pthread -Wl,--fatal-warnings runtime.o -o $out/runtime-cxx.wasm
        chmod 0755 $out/runtime-cxx.wasm
      '';
  # Keep the default ABI/runtime unchanged while validating standard EH
  # application lowering against the currently installed C++ runtime.
  modernEhPrograms =
    pkgs.runCommand "sdk-modern-eh-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
        test -s ${profileCheck}/profile.json
        mkdir $out
        flags=(-std=c++17 -O2 -pthread -Werror -mllvm -wasm-use-legacy-eh=false)
        wasm-linux-c++ "''${flags[@]}" -S ${../toolchain-smoke/runtime-cxx.cc} -o runtime.s
        node ${./check-modern-eh.mjs} runtime.s
        wasm-linux-c++ "''${flags[@]}" -c ${../toolchain-smoke/runtime-cxx.cc} -o runtime.o
        wasm-linux-c++ -pthread -Wl,--fatal-warnings runtime.o -o $out/runtime-cxx.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime-cxx.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/runtime-cxx.wasm
      '';
  cmakePrograms =
    pkgs.runCommand "sdk-cmake-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.ninja
          pkgs.nodejs
        ];
      }
      ''
        mkdir $out
        SDK_TEST_CMAKE_TOOLCHAIN=${sdk}/share/cmake/linux-wasm.cmake \
          SDK_TEST_PKG_CONFIG=${sdk}/bin/wasm-linux-pkg-config \
          SDK_TEST_OUTPUT_DIRECTORY=$out \
          node --test ${./.}/installed-consumer-test.js
        chmod 0755 $out/sdk-example.wasm
      '';
  zlibPrograms =
    pkgs.runCommand "sdk-zlib-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.ninja
          pkgs.nodejs
          pkgs.gnumake
        ];
        CC = "${cc}/bin/wasm-linux-cc";
        AR = "${llvm-toolchain}/bin/llvm-ar";
        RANLIB = "${llvm-toolchain}/bin/llvm-ranlib";
      }
      ''
        mkdir $out
        SDK_TEST_ZLIB_SOURCE=${zlib.src} \
          SDK_TEST_CMAKE_TOOLCHAIN=${sdk}/share/cmake/linux-wasm.cmake \
          SDK_TEST_PKG_CONFIG=${sdk}/bin/wasm-linux-pkg-config \
          SDK_TEST_OUTPUT_DIRECTORY=$out \
          node --test ${./.}/zlib-consumer-test.js
        chmod 0755 $out/sdk-zlib.wasm
      '';
  socketPrograms = pkgs.runCommand "sdk-socket-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      ${./socket-example.c} -o $out/sdk-socket.wasm
  '';
  timePrograms = pkgs.runCommand "sdk-time-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/time-abi.c} -o $out/sdk-time.wasm
  '';
  threadTimePrograms = pkgs.runCommand "sdk-thread-time-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/thread-time-abi.c} -o $out/sdk-thread-time.wasm
  '';
  signalWaitPrograms = pkgs.runCommand "sdk-signal-waits-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/signal-waits.c} -o $out/sdk-signal-waits.wasm
  '';
  signalIoPrograms = pkgs.runCommand "sdk-signal-io-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/signal-io.c} -o $out/sdk-signal-io.wasm
  '';
  signalFutexPrograms = pkgs.runCommand "sdk-signal-futex-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/signal-futex.c} -o $out/sdk-signal-futex.wasm
  '';
  futexPrograms = pkgs.runCommand "sdk-futex-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/futex.c} -o $out/sdk-futex.wasm
  '';
  robustMutexPrograms = pkgs.runCommand "sdk-robust-mutex-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${../basic-init/tests} ${../basic-init/tests/robust-mutex.c} -o $out/sdk-robust-mutex.wasm
  '';
  semaphoreDeadlinePrograms =
    pkgs.runCommand "sdk-semaphore-deadline-consumer-${platform.wasmArch}" { }
      ''
        mkdir $out
        ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
          -I${../basic-init/tests} ${../basic-init/tests/semaphore-deadline.c} -o $out/sdk-semaphore-deadline.wasm
      '';
  filesystemPrograms = pkgs.runCommand "sdk-filesystem-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    ${cxx}/bin/wasm-linux-c++ -std=c++17 -O2 -Wall -Wextra -Werror \
      ${./filesystem-example.cc} -o $out/sdk-filesystem.wasm
  '';
  sqlitePrograms = pkgs.runCommand "sdk-sqlite-consumer-${platform.wasmArch}" { } ''
    mkdir $out
    # Rebuild the upstream amalgamation with this SDK, not the wasm32
    # distribution library. Match the existing NOMMU SQLite profile.
    ${cc}/bin/wasm-linux-cc -O2 -pthread \
      -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION=1 \
      -DSQLITE_OMIT_WAL=1 -DSQLITE_MAX_MMAP_SIZE=0 \
      -I${sqlite3.src} -c ${sqlite3.src}/sqlite3.c -o sqlite3.o
    ${llvm-toolchain}/bin/llvm-ar rcs libsqlite3.a sqlite3.o
    ${cc}/bin/wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror \
      -I${sqlite3.src} ${./sqlite-example.c} ./libsqlite3.a -lm \
      -o $out/sdk-sqlite.wasm
  '';
  autoconfPrograms =
    pkgs.runCommand "sdk-autoconf-consumer-${platform.wasmArch}"
      {
        CC_FOR_BUILD = "${pkgs.stdenv.cc}/bin/cc";
        nativeBuildInputs = [
          pkgs.autoconf
          pkgs.automake
          pkgs.gnumake
          pkgs.nodejs
        ];
      }
      ''
        mkdir $out
        SDK_TEST_CONFIGURE=${sdk}/bin/wasm-linux-configure \
          SDK_TEST_CONFIG_SITE=${sdk}/share/linux-wasm-sdk/config.site \
          SDK_TEST_OUTPUT_DIRECTORY=$out \
          node --test ${./.}/autoconf-consumer-test.js
        chmod 0755 $out/sdk-autoconf.wasm
      '';
  mesonPrograms =
    pkgs.runCommand "sdk-meson-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          # Meson probes the build-machine static linker even in cross builds.
          pkgs.binutils
          meson
          pkgs.ninja
          pkgs.nodejs
        ];
        CC_FOR_BUILD = "${pkgs.stdenv.cc}/bin/cc";
        CXX_FOR_BUILD = "${pkgs.stdenv.cc}/bin/c++";
        PKG_CONFIG_FOR_BUILD = "${pkgs.pkg-config}/bin/pkg-config";
      }
      ''
        mkdir $out
        SDK_TEST_MESON_CROSS_FILE=${sdk}/share/meson/linux-wasm.ini \
          SDK_TEST_OUTPUT_DIRECTORY=$out \
          node --test ${./.}/meson-consumer-test.js
        chmod 0755 $out/sdk-meson.wasm
      '';
in
sdk
