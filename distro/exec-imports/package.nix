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
              "/exec-import-syscall-width" = "${program}/syscall-width.wasm";
              "/exec-import-syscall-result" = "${program}/syscall-result.wasm";
              "/exec-import-syscall-arity" = "${program}/syscall-arity.wasm";
              "/exec-import-poll-result" = "${program}/poll-result.wasm";
              "/exec-import-entry-missing" = "${program}/entry-missing.wasm";
              "/exec-import-entry-argument" = "${program}/entry-argument.wasm";
              "/exec-import-entry-result" = "${program}/entry-result.wasm";
              "/exec-import-entry-kind" = "${program}/entry-kind.wasm";
            };
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/exec-imports
        node ${./images.mjs} ${toString platform.addressBits} $out
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        for mode in runtime good immutable width float syscall-width syscall-result syscall-arity poll-result entry-missing entry-argument entry-result entry-kind; do
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
