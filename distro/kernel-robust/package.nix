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
    pkgs.runCommand "kernel-robust-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "kernel-robust-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/kernel-robust
        wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/runtime.wasm
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/kernel-robust/
        cp ${../sdk/LICENSE.MIT} $out/share/kernel-robust/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/kernel-robust/sdk-materials
      '';
in
program
