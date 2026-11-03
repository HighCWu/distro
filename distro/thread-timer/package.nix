# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  vm-test,
  libraryCoverage ? false,
  extraChecks ? { },
}:
let
  suffix = if libraryCoverage then "-libc" else "";
  program =
    pkgs.runCommand "thread-timer${suffix}-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "thread-timer${suffix}-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/thread-timer
        wasm-linux-cc -O2 -pthread -Wall -Wextra -Werror ${./runtime.c} \
          -Wl,--wrap=pthread_create -o $out/runtime.wasm
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/runtime.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 $out/runtime.wasm
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/thread-timer/
        cp ${../sdk/LICENSE.MIT} $out/share/thread-timer/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/thread-timer/sdk-materials
      '';
in
program
