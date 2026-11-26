# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  vm-test,
}:
let
  flags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  fixtures = pkgs.runCommand "initramfs-zstd-fixtures" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    python3 ${./make-fixture.py} "$out"
  '';
  program =
    pkgs.runCommand "initramfs-zstd-${platform.wasmArch}"
      {
        nativeBuildInputs = [
          llvm-toolchain
          pkgs.wabt
        ];
        passthru.checks.runtime = vm-test.rawInitramfsTest {
          name = "initramfs-zstd-${platform.wasmArch}";
          init = "${program}/initramfs-zstd.wasm";
          contents = [ fixtures ];
          initramfsCompression = "zstd";
          recordRuntimeLog = true;
        };
      }
      ''
        mkdir $out
        clang ${flags} -O2 -Wall -Wextra -Werror ${./runtime.c} -o $out/initramfs-zstd.wasm
        chmod 0755 $out/initramfs-zstd.wasm
        wasm-validate --enable-memory64 --enable-threads --enable-exceptions $out/initramfs-zstd.wasm
      '';
in
program
