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
    pkgs.runCommand "isofs-volume.iso"
      {
        nativeBuildInputs = [
          pkgs.python3
          pkgs.xorriso
        ];
      }
      ''
        mkdir -p iso-root
        python3 - <<'PY'
        from pathlib import Path

        payload_size = 6 * 65536 + 173
        payload = bytearray(payload_size)
        for position in range(payload_size):
            in_page = position % 4096
            page = position // 4096
            if in_page < 8:
                payload[position] = (page >> (in_page * 8)) & 0xff
            else:
                payload[position] = (in_page * 37 + (in_page >> 8) * 17) & 0xff

        Path("iso-root/Long ISO 文件名 spanning pages.bin").write_bytes(payload)
        PY
        xorriso -as mkisofs -J --norock -input-charset UTF-8 -V WASMISO \
          --set_all_file_dates 1970010100000000 --modification-date=1970010100000000 \
          -o "$out" iso-root
      '';
  program =
    pkgs.runCommand "isofs-volume-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "isofs-volume-${platform.wasmArch}";
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
