# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  musl,
  sysroot-base,
  llvm-runtimes,
  llvm-toolchain,
  sysroot,
  sdk,
  vm-test,
  busybox,
}:

assert platform.addressBits == 64;
assert platform.targetTriple == "wasm64-unknown-linux-musl";

let
  wordPlatform = platform // {
    compilerFlags = platform.compilerFlags ++ [ "-mabi=linux64" ];
  };

  muslWord = musl.override { linux64Abi = true; };
  baseWord = sysroot-base.override {
    platform = wordPlatform;
    musl = muslWord;
  };
  runtimesWord = llvm-runtimes.override {
    platform = wordPlatform;
    sysroot-base = baseWord;
  };
  toolchainWord = llvm-toolchain.override {
    platform = wordPlatform;
    llvm-runtimes = runtimesWord;
  };
  rootWord = sysroot.override {
    platform = wordPlatform;
    llvm-runtimes = runtimesWord;
    sysroot-base = baseWord;
  };
  stdenvWord = import ../stdenv.nix {
    inherit pkgs;
    platform = wordPlatform;
    llvm-toolchain = toolchainWord;
    sysroot = rootWord;
  };

  zlibWord = import ../zlib/package.nix {
    inherit pkgs vm-test busybox;
    stdenv = stdenvWord;
  };
  ncursesWord = import ../ncurses/package.nix {
    inherit pkgs vm-test busybox;
    stdenv = stdenvWord;
  };
  readlineWord = import ../readline/package.nix {
    inherit pkgs vm-test busybox;
    stdenv = stdenvWord;
    ncurses = ncursesWord;
  };
  sqlite3Word = import ../sqlite3/package.nix {
    inherit pkgs vm-test busybox;
    stdenv = stdenvWord;
    readline = readlineWord;
    ncurses = ncursesWord;
  };

  sdkWordBase = sdk.override {
    platform = wordPlatform;
    llvm-toolchain = toolchainWord;
    sysroot = rootWord;
    zlib = zlibWord;
    sqlite3 = sqlite3Word;
    extraMaterialTrees = {
      "recipes/linux64-abi" = ./.;
    };
  };

  runtimeProgram =
    pkgs.runCommand "linux64-abi-runtime-wasm64"
      {
        nativeBuildInputs = [ sdkWordBase ];
      }
      ''
        mkdir -p $out
        wasm-linux-cc -O2 -Wall -Wextra -Werror \
          ${./runtime.c} -o $out/linux64-abi-runtime.wasm
        chmod 0755 $out/linux64-abi-runtime.wasm
      '';

  runtimeCheck = vm-test.rawInitramfsTest {
    name = "linux64-abi-runtime-wasm64";
    init = "${runtimeProgram}/linux64-abi-runtime.wasm";
  };

  # Keep the ordinary SDK checks and attach the ABI execution test to the
  # derivation so the repository's recursive check collector sees both.
  sdkWord = sdkWordBase.overrideAttrs (old: {
    passthru = (old.passthru or { }) // {
      checks = (old.passthru.checks or { }) // {
        runtime = runtimeCheck;
        sdk-profile = old.passthru.checks.profile;
        sdk-cxx-runtime = old.passthru.checks.cxx-runtime;
        sdk-zlib-runtime = old.passthru.checks.zlib-runtime;
        sdk-sqlite-runtime = old.passthru.checks.sqlite-runtime;
        build-materials = old.passthru.checks.build-materials;
        source-bundle = old.passthru.checks.source-bundle;
        zlib = zlibWord.checks.roundtrip;
        ncurses = ncursesWord.checks.terminfo;
        readline = readlineWord.checks.line-editing;
        sqlite3 = sqlite3Word.checks.shell;
      };
    };
  });
in
{
  package = sdkWord;
  inherit wordPlatform;
  dependencies = {
    inherit
      muslWord
      baseWord
      runtimesWord
      toolchainWord
      rootWord
      stdenvWord
      zlibWord
      ncursesWord
      readlineWord
      sqlite3Word
      ;
  };
  checks = {
    runtime = runtimeCheck;
    sdk-profile = sdkWord.checks.profile;
    sdk-cxx-runtime = sdkWord.checks.cxx-runtime;
    sdk-zlib-runtime = sdkWord.checks.zlib-runtime;
    sdk-sqlite-runtime = sdkWord.checks.sqlite-runtime;
    build-materials = sdkWord.checks.build-materials;
    source-bundle = sdkWord.checks.source-bundle;
    zlib = zlibWord.checks.roundtrip;
    ncurses = ncursesWord.checks.terminfo;
    readline = readlineWord.checks.line-editing;
    sqlite3 = sqlite3Word.checks.shell;
  };
  recurseForDerivations = true;
}
