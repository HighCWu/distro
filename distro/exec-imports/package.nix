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
    pkgs.runCommand "exec-imports-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "exec-imports-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            files = {
              "/exec-import-good" = "${program}/good.wasm";
              "/exec-import-immutable" = "${program}/immutable.wasm";
              "/exec-import-width" = "${program}/width.wasm";
              "/exec-import-float" = "${program}/float.wasm";
            };
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/exec-imports
        node ${./images.mjs} ${toString platform.addressBits} $out
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        for mode in runtime good immutable width float; do
          node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
            $out/$mode.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
          chmod 0755 $out/$mode.wasm
        done
        cp ${./runtime.c} ${./images.mjs} ${./package.nix} ${./README.md} $out/share/exec-imports/
        cp ${../sdk/LICENSE.MIT} $out/share/exec-imports/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/exec-imports/sdk-materials
      '';
in
program
