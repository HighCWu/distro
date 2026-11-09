# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk-fork-cooperative-poll,
  vm-test,
  libraryCoverage ? false,
  extraChecks ? { },
}:
let
  suffix = if libraryCoverage then "-libc" else "";
  runtimeName = if libraryCoverage then "runtime-libc.wasm" else "runtime.wasm";
  program =
    pkgs.runCommand "fork-poll${suffix}-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk-fork-cooperative-poll
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "fork-poll${suffix}-${platform.wasmArch}";
            init = "${program}/${runtimeName}";
            cpus = 2;
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/fork-poll
        wasm-linux-fork-cc ${if libraryCoverage then "-DFORK_LIBRARY_POLL=1 -pthread" else ""} \
          -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        wasm-linux-fork-finalize linked.wasm $out/${runtimeName}
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/${runtimeName} ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/fork-poll/
        cp ${../sdk/LICENSE.MIT} $out/share/fork-poll/LICENSE.MIT
        ln -s ${sdk-fork-cooperative-poll.buildMaterials} $out/share/fork-poll/sdk-materials
      '';
in
program
