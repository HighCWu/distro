# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
}:
pkgs.runCommand "dynamic-cooperative-execution-${platform.wasmArch}"
  {
    nativeBuildInputs = [ llvm-toolchain ];
  }
  ''
    mkdir -p $out
    clang ${
      lib.escapeShellArgs (
        [
          "--target=${platform.targetTriple}"
          "--sysroot=${sysroot}"
        ]
        ++ platform.compilerFlags
      )
    } \
      -DWASM_POLL_THREAD_GLOBAL=1 \
      -fno-sanitize-coverage=trace-pc,no-prune,edge \
      -O2 -Wall -Wextra -Werror \
      -c ${../cooperative-poll/execution.c} \
      -o $out/cooperative-execution.o
  ''
