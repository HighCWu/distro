# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  image,
  vm-test,
}:

let
  compileFlags = lib.escapeShellArgs (
    [
      "--target=${platform.targetTriple}"
      "--sysroot=${sysroot}"
      "-O2"
      "-I${../basic-init/tests}"
      "-Wl,--fatal-warnings"
    ]
    ++ platform.compilerFlags
    ++ map (flag: "-Wl,${flag}") platform.linkerFlags
  );
  executables =
    pkgs.runCommand "mmap-benchmark-programs-${platform.wasmArch}"
      { nativeBuildInputs = [ llvm-toolchain ]; }
      ''
        mkdir -p $out
        clang ${compileFlags} ${../basic-init/tests/mmap.c} -o $out/correctness.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-offsets.c} -o $out/offsets.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-benchmark.c} -o $out/benchmark.wasm
        chmod 0755 $out/*.wasm
      '';
  correctness = image.mkInitramfs {
    name = "mmap-correctness-${platform.wasmArch}";
    init = "${executables}/correctness.wasm";
  };
  benchmark = image.mkInitramfs {
    name = "mmap-benchmark-${platform.wasmArch}";
    init = "${executables}/benchmark.wasm";
  };
in
pkgs.runCommand "mmap-benchmark-artifacts-${platform.wasmArch}"
  {
    passthru.checks.correctness = vm-test.rawInitramfsTest {
      name = "mmap-correctness-${platform.wasmArch}";
      init = "${executables}/correctness.wasm";
      cpus = 4;
    };
    passthru.checks.offsets = vm-test.rawInitramfsTest {
      name = "mmap-offsets-${platform.wasmArch}";
      init = "${executables}/offsets.wasm";
    };
  }
  ''
    mkdir -p $out
    ln -s ${correctness} $out/correctness.cpio
    ln -s ${benchmark} $out/benchmark.cpio
  ''
