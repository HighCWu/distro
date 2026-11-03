# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-fork-continuation,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "clone-exit-signal-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-fork-continuation
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "clone-exit-signal-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/clone-exit-signal
        wasm-linux-fork-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/clone-exit-signal/
        cp ${../sdk/LICENSE.MIT} $out/share/clone-exit-signal/LICENSE.MIT
        ln -s ${sdk-fork-continuation.buildMaterials} $out/share/clone-exit-signal/sdk-materials
      '';
in
program
