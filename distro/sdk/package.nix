# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
}:
let
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
  cmakeToolchain = pkgs.replaceVars ./linux-wasm.cmake.in {
    inherit (platform) wasmArch;
    cc = "${cc}/bin/wasm-linux-cc";
    cxx = "${cxx}/bin/wasm-linux-c++";
    ar = "${llvm-toolchain}/bin/llvm-ar";
    ranlib = "${llvm-toolchain}/bin/llvm-ranlib";
    sysroot = "${sysroot}";
  };
  cmakeFiles = pkgs.runCommand "sdk-cmake-${platform.wasmArch}" { } ''
    mkdir -p $out/share/cmake
    cp ${cmakeToolchain} $out/share/cmake/linux-wasm.cmake
  '';
  sdk = pkgs.symlinkJoin {
    name = "linux-wasm-sdk-${platform.wasmArch}";
    paths = [
      cc
      cxx
      cmakeFiles
      llvm-toolchain
    ];
    passthru.checks = {
      wrapper = pkgs.runCommand "sdk-wrapper-contract" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
        cp ${./compiler.sh} compiler.sh
        cp ${./wrapper-test.js} wrapper-test.js
        node --test wrapper-test.js
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
        ];
      }
      ''
          cmake -S ${./cmake-example} -B build -G Ninja \
            -DCMAKE_TOOLCHAIN_FILE=${sdk}/share/cmake/linux-wasm.cmake \
        -DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON \
            -DCMAKE_BUILD_TYPE=Release
          cmake --build build --verbose
          mkdir $out
          cp build/sdk-example.wasm $out/
          chmod 0755 $out/sdk-example.wasm
      '';
in
sdk
