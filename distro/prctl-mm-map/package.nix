# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
  busybox,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "prctl-mm-map-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.installedTest {
            name = "prctl-mm-map-${platform.wasmArch}";
            init = ./runtime-test.sh;
            contents = [
              busybox
              program
            ];
            cpus = 2;
          };
        }
        // extraChecks;
        meta.license = lib.licenses.mit;
      }
      ''
        mkdir -p "$out/bin" "$out/share/prctl-mm-map"
        wasm-linux-cc -std=c11 -O2 -Wall -Wextra -Werror ${./runtime.c} -o "$out/bin/prctl-mm-map"
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$out/bin/prctl-mm-map" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 "$out/bin/prctl-mm-map"
        cp ${./runtime.c} "$out/share/prctl-mm-map/runtime.c"
        cp ${./runtime-test.sh} "$out/share/prctl-mm-map/runtime-test.sh"
        cp ${./package.nix} "$out/share/prctl-mm-map/package.nix"
        cp ${../sdk/LICENSE.MIT} "$out/share/prctl-mm-map/LICENSE.MIT"
        ln -s ${sdk.buildMaterials} "$out/share/prctl-mm-map/sdk-materials"
      '';
in
program
