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
  wrapper =
    name: compiler:
    pkgs.writeShellApplication {
      inherit name;
      text =
        builtins.replaceStrings
          [ "@compiler@" "@compileFlags@" "@linkFlags@" ]
          [
            (lib.escapeShellArg "${llvm-toolchain}/bin/${compiler}")
            (lib.escapeShellArgs (
              [
                "--target=${platform.targetTriple}"
                "--sysroot=${sysroot}"
              ]
              ++ platform.compilerFlags
            ))
            (lib.escapeShellArgs (map (flag: "-Wl,${flag}") platform.linkerFlags))
          ]
          (builtins.readFile ./compiler.sh);
    };
  sdk = pkgs.symlinkJoin {
    name = "linux-wasm-sdk-${platform.wasmArch}";
    paths = [
      (wrapper "wasm-linux-cc" "clang")
      (wrapper "wasm-linux-c++" "clang++")
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
    };
  };
  programs = pkgs.runCommand "sdk-consumer-${platform.wasmArch}" { nativeBuildInputs = [ sdk ]; } ''
    mkdir $out
    # Separate compilation is part of the public consumer contract.
    wasm-linux-c++ -std=c++17 -O2 -pthread -Werror -c ${../toolchain-smoke/runtime-cxx.cc} -o runtime.o
    wasm-linux-c++ -pthread -Wl,--fatal-warnings runtime.o -o $out/runtime-cxx.wasm
    chmod 0755 $out/runtime-cxx.wasm
  '';
in
sdk
