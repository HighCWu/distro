# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  program =
    pkgs.runCommand "psi-runtime-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "psi-runtime-${platform.wasmArch}";
          init = "${program}/runtime.wasm";
          cpus = 1;
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir -p $out/share/psi-runtime
        wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/runtime.wasm
        cp ${./runtime.c} ${./package.nix} $out/share/psi-runtime/
        cp ${../sdk/LICENSE.MIT} $out/share/psi-runtime/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/psi-runtime/sdk-materials
      '';
in
program
