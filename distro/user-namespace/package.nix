# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "user-namespace-${platform.wasmArch}"
      {
        nativeBuildInputs = [ sdk ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "user-namespace-${platform.wasmArch}";
            init = "${program}/user-namespace.wasm";
            files."/userns-helper" = "${program}/helper.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir $out
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/user-namespace.wasm
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./helper.c} -o $out/helper.wasm
        chmod 0755 $out/*.wasm
      '';
in
program
