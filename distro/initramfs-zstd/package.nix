# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
  compression ? "zstd",
}:
assert lib.assertMsg (
  compression == "zstd" || compression == "xz"
) "unsupported initramfs fixture compression";
let
  name = "initramfs-${compression}";
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
    ++ lib.optionals (compression == "xz") [ ''-DINITRAMFS_FIXTURE_NAME="${name}"'' ]
  );
  fixtures = pkgs.runCommand "initramfs-zstd-fixtures" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    python3 ${./make-fixture.py} "$out"
  '';
  program =
    pkgs.runCommand "${name}-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "${name}-${platform.wasmArch}";
          init = "${program}/${name}.wasm";
          contents = [ fixtures ];
          pathModes = {
            "/zstd-fixture/payload.bin" = "0640";
            "/zstd-fixture/executable" = "0751";
            "/zstd-fixture/empty" = "0750";
          };
          initramfsCompression = compression;
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/${name}.wasm
        chmod 0755 $out/${name}.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/${name}.wasm
      '';
in
program
