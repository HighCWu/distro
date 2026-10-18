# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  musl,
  sysroot-base,
  sysroot,
  llvm-toolchain,
  vm-test,
}:
let
  forkMusl = musl.override { enableForkContinuation = true; };
  forkBase = sysroot-base.override { musl = forkMusl; };
  forkRoot = sysroot.override { sysroot-base = forkBase; };
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${forkRoot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
    ++ [
      "-Wl,--export=__stack_pointer"
      "-Wl,--export=__tls_base"
    ]
  );
  program =
    pkgs.runCommand "fork-continuation-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.binaryen
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "fork-continuation-${platform.wasmArch}";
          init = "${program}/fork.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir -p $out
        clang --version
        wasm-opt --version
        clang ${flags} -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o raw.wasm
        wasm-opt raw.wasm --enable-threads --enable-bulk-memory --enable-mutable-globals \
          --enable-sign-ext --enable-nontrapping-float-to-int --enable-memory64 \
          --enable-exception-handling --asyncify \
          --pass-arg=asyncify-imports@linux_fork_v1.checkpoint \
          --pass-arg=asyncify-asserts -o $out/fork.wasm
        chmod 0755 $out/fork.wasm
      '';
in
program
