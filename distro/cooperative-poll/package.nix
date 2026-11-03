# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-cooperative-poll,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "cooperative-poll-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-cooperative-poll
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "cooperative-poll-${platform.wasmArch}";
            init = "${program}/cooperative-poll.wasm";
            files."/poll-helper" = "${program}/cooperative-poll.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir $out
        wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/cooperative-poll.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/cooperative-poll.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/cooperative-poll.wasm
      '';
in
program
