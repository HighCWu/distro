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
    pkgs.runCommand "exec-security-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          sdk-fork-continuation
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "exec-security-${platform.wasmArch}";
          init = "${program}/exec-security.wasm";
          files = {
            "/plain-helper" = "${program}/helper.wasm";
            "/secure-helper" = "${program}/helper.wasm";
          };
          cpus = 2;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./helper.c} -o $out/helper.wasm
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/exec-security.wasm
        chmod 0755 $out/helper.wasm $out/exec-security.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/helper.wasm
      '';
in
program
