# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  sdk-fork-continuation,
  vm-test,
}:
let
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  program =
    pkgs.runCommand "binfmt-misc-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "binfmt-misc-${platform.wasmArch}";
          init = "${program}/binfmt-misc.wasm";
          files."/misc-helper" = "${program}/helper.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./helper.c} -o $out/helper.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/binfmt-misc.wasm
        chmod 0755 $out/helper.wasm $out/binfmt-misc.wasm
      '';
in
program
