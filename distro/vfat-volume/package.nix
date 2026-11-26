# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  disk = pkgs.runCommand "vfat-volume-fat16.img" { nativeBuildInputs = [ pkgs.dosfstools ]; } ''
    truncate -s 32M "$out"
    mkfs.vfat --invariant -F 16 -S 512 -s 8 -i 1234abcd -n WASMTEST "$out"
    LC_ALL=C fsck.fat -vn "$out" > fsck.txt
    grep -q '16 bit entries' fsck.txt
  '';
  program =
    pkgs.runCommand "vfat-volume-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "vfat-volume-${platform.wasmArch}";
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
