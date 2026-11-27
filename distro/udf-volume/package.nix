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
    pkgs.runCommand "udf-volume.iso"
      {
        nativeBuildInputs = [
          pkgs.genisoimage
          pkgs.python3
        ];
      }
      ''
        mkdir -p volume
        python3 - <<'PY'
        from pathlib import Path

        payload_size = 6 * 65536 + 173
        payload = bytes((position * 37 + position // 4096) & 0xff for position in range(payload_size))
        Path("volume/UDF payload crossing pages.bin").write_bytes(payload)
        PY
        genisoimage -quiet -udf -iso-level 3 -V WASMTEST -o "$out" volume
      '';
  program =
    pkgs.runCommand "udf-volume-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "udf-volume-${platform.wasmArch}";
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
