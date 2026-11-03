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
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  program =
    pkgs.runCommand "landlock-${platform.wasmArch}"
      {
        nativeBuildInputs = [ llvm-toolchain ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "landlock-${platform.wasmArch}";
          init = "${program}/landlock.wasm";
          files."/landlock-helper" = "${program}/helper.wasm";
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/landlock.wasm
        clang ${flags} -O2 -Wall -Wextra -Werror ${./helper.c} -o $out/helper.wasm
        chmod 0755 $out/landlock.wasm $out/helper.wasm
      '';
in
program
