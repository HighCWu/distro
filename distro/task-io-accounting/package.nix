# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  delayProgram =
    pkgs.runCommand "task-delay-accounting-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
      }
      ''
        mkdir -p "$out"
        wasm-linux-cc -O2 -pthread -DTASK_DELAY_RUNTIME -Wall -Wextra -Werror ${./runtime.c} -o "$out/runtime.wasm"
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$out/runtime.wasm" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 "$out/runtime.wasm"
      '';
  program =
    pkgs.runCommand "task-io-accounting-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "task-io-accounting-${platform.wasmArch}";
          init = "${program}/runtime.wasm";
          recordRuntimeLog = true;
        };
        passthru.checks.delay = vm-test.rawInitramfsTest {
          name = "task-delay-accounting-${platform.wasmArch}";
          init = "${delayProgram}/runtime.wasm";
          cpus = 1;
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir -p $out/share/task-io-accounting
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/runtime.wasm
        cp ${./runtime.c} ${./package.nix} $out/share/task-io-accounting/
        cp ${../sdk/LICENSE.MIT} $out/share/task-io-accounting/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/task-io-accounting/sdk-materials
      '';
in
program
