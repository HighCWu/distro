# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-fork-cooperative-poll,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "fork-poll-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-fork-cooperative-poll
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "fork-poll-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/fork-poll
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/fork-poll/
        cp ${../sdk/LICENSE.MIT} $out/share/fork-poll/LICENSE.MIT
        ln -s ${sdk-fork-cooperative-poll.buildMaterials} $out/share/fork-poll/sdk-materials
      '';
in
program
