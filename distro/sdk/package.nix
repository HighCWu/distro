# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
  zlib,
}:
let
  meson = import ./meson.nix { inherit pkgs; };
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
  sdk = pkgs.symlinkJoin {
    name = "linux-wasm-sdk-${platform.wasmArch}";
    paths = [
      cc
      cxx
      pkgConfig
      configure
      cmakeFiles
      mesonFiles
      llvm-toolchain
    ];
    passthru.meson = meson;
    passthru.checks = {
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
      cmake-runtime = vm-test.rawInitramfsTest {
        name = "sdk-cmake-runtime-${platform.wasmArch}";
        init = "${cmakePrograms}/sdk-example.wasm";
        cpus = 2;
      };
      zlib-runtime = vm-test.rawInitramfsTest {
        name = "sdk-zlib-runtime-${platform.wasmArch}";
        init = "${zlibPrograms}/sdk-zlib.wasm";
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
  programs =
    pkgs.runCommand "sdk-consumer-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
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
        wasm-linux-c++ -std=c++17 -O2 -pthread -Werror -c ${../toolchain-smoke/runtime-cxx.cc} -o runtime.o
        wasm-linux-c++ -pthread -Wl,--fatal-warnings runtime.o -o $out/runtime-cxx.wasm
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
  autoconfPrograms =
    pkgs.runCommand "sdk-autoconf-consumer-${platform.wasmArch}"
      {
        CC_FOR_BUILD = "${pkgs.stdenv.cc}/bin/cc";
        nativeBuildInputs = [
          pkgs.autoconf
          pkgs.gnumake
          pkgs.nodejs
        ];
      }
      ''
        mkdir $out
        SDK_TEST_CONFIGURE=${sdk}/bin/wasm-linux-configure \
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
