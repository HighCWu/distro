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
    pkgs.runCommand "keyrings-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "keyrings-${platform.wasmArch}";
          init = "${program}/keyrings.wasm";
          files."/keyring-helper" = "${program}/helper.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -I${./.} -O2 -Wall -Wextra -Werror ${./helper.c} -o $out/helper.wasm
        wasm-linux-fork-cc -I${./.} -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/keyrings.wasm
        chmod 0755 $out/helper.wasm $out/keyrings.wasm
      '';
in
program
