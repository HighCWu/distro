# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  sysroot-base,
  musl,
  sdk,
  libraryCoverage ? false,
}:
let
  selectedRoot =
    if libraryCoverage then
      sysroot.override {
        sysroot-base = sysroot-base.override { musl = musl.override { enableCooperativePoll = true; }; };
      }
    else
      sysroot;
  execution =
    pkgs.runCommand "cooperative-poll-execution-${platform.wasmArch}"
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
        } \
          ${lib.optionalString libraryCoverage "-DWASM_POLL_THREAD_GLOBAL=1"} \
          -O2 -Wall -Wextra -Werror -c ${./execution.c} -o $out/user-poll.o
        mkdir -p $out/share/linux-wasm-cooperative-poll
        cp ${./execution.c} $out/share/linux-wasm-cooperative-poll/execution.c
        cp ${./sdk.nix} $out/share/linux-wasm-cooperative-poll/sdk.nix
        cp ${./README.md} $out/share/linux-wasm-cooperative-poll/README.md
        cp ${../sdk/LICENSE.MIT} $out/share/linux-wasm-cooperative-poll/LICENSE.MIT
      '';
  routed = sdk.override {
    sysroot = selectedRoot;
    extraLinkerInputs = [ "${execution}/user-poll.o" ];
    platform = platform // {
      compilerFlags = platform.compilerFlags ++ [
        "-fsanitize-coverage=trace-pc,no-prune,edge"
      ];
      linkerFlags = platform.linkerFlags ++ [
        "--export=__tls_base"
        "--export=__wasm_user_poll_abi"
      ];
    };
  };
in
pkgs.symlinkJoin {
  name = "linux-wasm-cooperative-poll-sdk-${platform.wasmArch}${lib.optionalString libraryCoverage "-libc"}";
  paths = [
    routed
    execution
  ];
  passthru = (routed.passthru or { }) // {
    executionMaterials = "${execution}/share/linux-wasm-cooperative-poll";
  };
}
