# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  disk =
    pkgs.runCommand "ntfs-volume.img"
      {
        nativeBuildInputs = [
          pkgs.ntfs3g
          pkgs.python3
        ];
      }
      ''
        truncate -s 32M "$out"
        mkntfs -F -Q -L WASMTEST "$out"
        python3 - <<'PY'
        from pathlib import Path

        payload_size = 6 * 65536 + 173
        payload = bytes((position * 37 + position // 4096) & 0xff for position in range(payload_size))
        Path("ntfs-payload.bin").write_bytes(payload)
        PY
        ntfscp -q "$out" ntfs-payload.bin "/NTFS payload crossing pages.bin"
        ntfsls -p / "$out" | grep -Fqx "NTFS payload crossing pages.bin"
      '';
  program =
    pkgs.runCommand "ntfs-volume-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "ntfs-volume-${platform.wasmArch}";
          init = "${program}/runtime.wasm";
          disks = [ disk ];
          readOnlyDisks = true;
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
