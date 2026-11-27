# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  disk = pkgs.runCommand "exfat-volume.img" { nativeBuildInputs = [ pkgs.exfatprogs ]; } ''
    truncate -s 32M "$out"
    mkfs.exfat -L WASMTEST "$out"
    LC_ALL=C fsck.exfat -n "$out"
  '';
  program =
    pkgs.runCommand "exfat-volume-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "exfat-volume-${platform.wasmArch}";
          init = "${program}/runtime.wasm";
          disks = [ disk ];
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir -p "$out"
        wasm-linux-cc -O2 -Wall -Wextra -Werror ${./runtime.c} -o "$out/runtime.wasm"
        node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
          "$out/runtime.wasm" ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
        chmod 0755 "$out/runtime.wasm"
      '';
in
program
