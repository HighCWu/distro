# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  sdk,
  vm-test,
}:
let
  disk = pkgs.runCommand "cgroup-io.raw" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    python3 - "$out" <<'PY'
    import sys
    from pathlib import Path

    image = bytearray(512 * 1024)
    start = 128 * 1024
    size = 16 * 1024
    image[start:start + size] = bytes(((i * 31) ^ (i >> 5)) & 255 for i in range(size))
    Path(sys.argv[1]).write_bytes(image)
    PY
  '';
  program =
    pkgs.runCommand "cgroup-io-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          sdk
          pkgs.nodejs
        ];
        meta.license = lib.licenses.mit;
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "cgroup-io-${platform.wasmArch}";
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
