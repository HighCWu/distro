# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  platform,
  llvm-toolchain,
  sysroot,
  image,
  vm-test,
  vm-test-copy,
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
        clang ${compileFlags} ${../basic-init/tests/mmap-initialized.c} -o $out/initialized.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-copy.c} -o $out/copy.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-staging.c} -o $out/staging.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-staging-legacy.c} -o $out/staging-legacy.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs.c} -o $out/vfs.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-provenance.c} -o $out/provenance.wasm
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
  provenanceImage =
    pkgs.runCommand "mmap-provenance.erofs"
      {
        nativeBuildInputs = [ pkgs.erofs-utils ];
      }
      ''
        mkdir root
        printf 'snapshot-provenance\n' > root/data
        mkfs.erofs --all-root -T 0 -x-1 "$out" root
      '';
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
    passthru.checks.initialized = vm-test.rawInitramfsTest {
      name = "mmap-initialized-${platform.wasmArch}";
      init = "${executables}/initialized.wasm";
      cpus = 2;
    };
    passthru.checks.copy = vm-test.rawInitramfsTest {
      name = "mmap-copy-${platform.wasmArch}";
      init = "${executables}/copy.wasm";
    };
    passthru.checks.vfs = vm-test-copy.rawInitramfsTest {
      name = "mmap-vfs-${platform.wasmArch}";
      init = "${executables}/vfs.wasm";
    };
    passthru.checks.provenance = vm-test-copy.rawInitramfsTest {
      name = "mmap-provenance-${platform.wasmArch}";
      init = "${executables}/provenance.wasm";
      disks = [
        provenanceImage
        provenanceImage
      ];
      snapshotFirstDisk = true;
      readOnlyDisks = true;
    };
    passthru.checks.staging =
      pkgs.runCommand "mmap-staging-checks-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          success = vm-test-copy.rawInitramfsTest {
            name = "mmap-staging-${platform.wasmArch}";
            init = "${executables}/staging.wasm";
          };
          legacy = vm-test-copy.rawInitramfsTest {
            name = "mmap-staging-legacy-${platform.wasmArch}";
            init = "${executables}/staging-legacy.wasm";
          };
        }
        ''
          mkdir $out
          ln -s "$success" $out/success
          ln -s "$legacy" $out/legacy
        '';
  }
  ''
    mkdir -p $out
    ln -s ${correctness} $out/correctness.cpio
    ln -s ${benchmark} $out/benchmark.cpio
  ''
