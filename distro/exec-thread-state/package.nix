# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  sdk,
  llvm-toolchain,
  vm-test,
  extraChecks ? { },
}:
let
  program =
    pkgs.runCommand "exec-thread-state-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          llvm-toolchain
          pkgs.nodejs
        ];
        passthru.checks = {
          runtime = vm-test.rawInitramfsTest {
            name = "exec-thread-state-${platform.wasmArch}";
            init = "${program}/runtime.wasm";
            files = {
              "/exec-thread-self" = "${program}/runtime.wasm";
              "/exec-thread-entry" = "${program}/entry.wasm";
            };
          };
        }
        // extraChecks;
      }
      ''
        mkdir -p $out/share/exec-thread-state
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/runtime.wasm
        # Deliberately omit all CRT/libc objects and their TLS installation.
        clang --target=${platform.targetTriple} -O2 -Wall -Wextra -Werror \
          -matomics -mbulk-memory -nostdlib ${./entry.c} \
          -Wl,--no-entry,--export=_start,--import-memory,--shared-memory,--export-table,--export=__stack_pointer,--max-memory=${toString platform.maximumMemoryBytes} \
          -o $out/entry.wasm
        for file in runtime entry; do
          node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
            $out/$file.wasm ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
          chmod 0755 $out/$file.wasm
        done
        cp ${./runtime.c} ${./entry.c} ${./package.nix} ${./README.md} $out/share/exec-thread-state/
        cp ${../sdk/LICENSE.MIT} $out/share/exec-thread-state/LICENSE.MIT
        ln -s ${sdk.buildMaterials} $out/share/exec-thread-state/sdk-materials
      '';
in
program
