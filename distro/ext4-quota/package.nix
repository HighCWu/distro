# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  disk = pkgs.runCommand "ext4-user-quota.img" { nativeBuildInputs = [ pkgs.e2fsprogs ]; } ''
    truncate -s 16M "$out"
    mkfs.ext4 -F -q -O quota -E quotatype=usrquota,lazy_itable_init=0,lazy_journal_init=0 "$out"
    LC_ALL=C dumpe2fs -h "$out" > superblock
    grep -E '^User quota inode:[[:space:]]+[1-9][0-9]*$' superblock
  '';
  program =
    pkgs.runCommand "ext4-quota-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "ext4-quota-${platform.wasmArch}";
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
