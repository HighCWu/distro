# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk-fork-cooperative-poll,
  vm-test,
  libraryCoverage ? false,
  automaticFinalize ? false,
  extraChecks ? { },
}:
let
  suffix = lib.optionalString libraryCoverage "-libc" + lib.optionalString automaticFinalize "-auto";
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
        node --input-type=module <<'NODE'
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        const profile = JSON.parse(readFileSync("${sdk-fork-cooperative-poll}/share/linux-wasm-fork-sdk/profile.json", "utf8"));
        assert.equal(profile.automaticFinalization, ${lib.boolToString automaticFinalize});
        NODE
        wasm-linux-fork-cc ${if libraryCoverage then "-DFORK_LIBRARY_POLL=1 -pthread" else ""} \
          -O2 -Wall -Wextra -Werror ${./runtime.c} -o linked.wasm
        ${
          if automaticFinalize then
            ''mv linked.wasm "$out/${runtimeName}"''
          else
            ''wasm-linux-fork-finalize linked.wasm "$out/${runtimeName}"''
        }
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          $out/${runtimeName} ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        cp ${./runtime.c} ${./package.nix} ${./README.md} $out/share/fork-poll/
        cp ${../sdk/LICENSE.MIT} $out/share/fork-poll/LICENSE.MIT
        ln -s ${sdk-fork-cooperative-poll.buildMaterials} $out/share/fork-poll/sdk-materials
      '';
in
program
