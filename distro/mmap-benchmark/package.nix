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
        clang ${compileFlags} ${../basic-init/tests/stat-abi.c} -o $out/stat-abi.wasm
        clang ${compileFlags} ${../basic-init/tests/time-abi.c} -o $out/time-abi.wasm
        clang ${compileFlags} -pthread ${../basic-init/tests/thread-time-abi.c} -o $out/thread-time-abi.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-initialized.c} -o $out/initialized.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-copy.c} -o $out/copy.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-staging.c} -o $out/staging.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-staging-legacy.c} -o $out/staging-legacy.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs.c} -o $out/vfs.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-lifetime.c} -o $out/vfs-lifetime.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-signal.c} -o $out/vfs-signal.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-restart.c} -o $out/vfs-restart.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-clone.c} -o $out/vfs-clone.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-exit.c} -o $out/vfs-exit.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-vfs-last-fd.c} -o $out/vfs-last-fd.wasm
        clang ${compileFlags} ${../basic-init/tests/mmap-provenance.c} -o $out/provenance.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-erofs.c} -o $out/erofs.wasm
        clang ${compileFlags} -Wl,--export=__wasm_mmap_init_v1 ${../basic-init/tests/mmap-erofs-errors.c} -o $out/erofs-errors.wasm
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
        nativeBuildInputs = [
          pkgs.erofs-utils
          pkgs.python3
        ];
      }
      ''
        mkdir root
        printf 'snapshot-provenance\n' > root/data
        python3 -c 'from pathlib import Path; Path("root/pattern").write_bytes(bytes((i * 37 + 11) & 255 for i in range(2 * 65536 + 7))); Path("root/empty").touch()'
        mkfs.erofs --all-root -T 0 -x-1 "$out" root
      '';
  readErrorImage =
    pkgs.runCommand "mmap-erofs-read-error.img" { nativeBuildInputs = [ pkgs.python3 ]; }
      ''
        cp ${../../scripts/make-erofs-read-error.py} make-erofs-read-error.py
        cp ${../../scripts/test_erofs_read_error.py} test_erofs_read_error.py
        python3 -B test_erofs_read_error.py
        python3 ${../../scripts/make-erofs-read-error.py} "$out"
      '';
in
pkgs.runCommand "mmap-benchmark-artifacts-${platform.wasmArch}"
  {
    passthru.erofsBrowserAssets = {
      initramfs = image.mkInitramfs {
        name = "mmap-erofs-browser-${platform.wasmArch}";
        init = "${executables}/erofs.wasm";
      };
      disk = provenanceImage;
      errors = {
        initramfs = image.mkInitramfs {
          name = "mmap-erofs-errors-browser-${platform.wasmArch}";
          init = "${executables}/erofs-errors.wasm";
        };
        disk = readErrorImage;
      };
    };
    passthru.checks.correctness = vm-test.rawInitramfsTest {
      name = "mmap-correctness-${platform.wasmArch}";
      init = "${executables}/correctness.wasm";
      cpus = 4;
    };
    passthru.checks.offsets = vm-test.rawInitramfsTest {
      name = "mmap-offsets-${platform.wasmArch}";
      init = "${executables}/offsets.wasm";
    };
    # Ordinary Linux APIs on the default kernel, not the mmap-copy test kernel.
    passthru.checks.stat = vm-test.rawInitramfsTest {
      name = "stat-abi-${platform.wasmArch}";
      init = "${executables}/stat-abi.wasm";
    };
    passthru.checks.time = vm-test.rawInitramfsTest {
      name = "time-abi-${platform.wasmArch}";
      init = "${executables}/time-abi.wasm";
    };
    passthru.checks.thread-time = vm-test.rawInitramfsTest {
      name = "thread-time-abi-${platform.wasmArch}";
      init = "${executables}/thread-time-abi.wasm";
      cpus = 2;
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
    passthru.checks.vfs-lifetime =
      pkgs.runCommand "mmap-vfs-lifetime-checks-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          lifetime = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-lifetime-${platform.wasmArch}";
            init = "${executables}/vfs-lifetime.wasm";
            cpus = 2;
          };
          regression = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-${platform.wasmArch}";
            init = "${executables}/vfs.wasm";
          };
        }
        ''
          mkdir $out
          ln -s "$lifetime" $out/lifetime
          ln -s "$regression" $out/regression
        '';
    passthru.checks.vfs-signal =
      pkgs.runCommand "mmap-vfs-signal-checks-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          signal = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-signal-${platform.wasmArch}";
            init = "${executables}/vfs-signal.wasm";
            cpus = 2;
          };
          lifetime = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-lifetime-${platform.wasmArch}";
            init = "${executables}/vfs-lifetime.wasm";
            cpus = 2;
          };
          regression = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-${platform.wasmArch}";
            init = "${executables}/vfs.wasm";
          };
        }
        ''
          mkdir $out
          ln -s "$signal" $out/signal
          ln -s "$lifetime" $out/lifetime
          ln -s "$regression" $out/regression
        '';
    passthru.checks.vfs-restart = vm-test-copy.rawInitramfsTest {
      name = "mmap-vfs-restart-${platform.wasmArch}";
      init = "${executables}/vfs-restart.wasm";
      cpus = 2;
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
    passthru.checks.vfs-clone = vm-test-copy.rawInitramfsTest {
      name = "mmap-vfs-clone-${platform.wasmArch}";
      init = "${executables}/vfs-clone.wasm";
      cpus = 2;
    };
    passthru.checks.vfs-exit = vm-test-copy.rawInitramfsTest {
      name = "mmap-vfs-exit-${platform.wasmArch}";
      init = "${executables}/vfs-exit.wasm";
      cpus = 2;
    };
    passthru.checks.vfs-last-fd = vm-test-copy.rawInitramfsTest {
      name = "mmap-vfs-last-fd-${platform.wasmArch}";
      init = "${executables}/vfs-last-fd.wasm";
      cpus = 2;
    };
    passthru.checks.vfs-resources =
      pkgs.runCommand "mmap-vfs-resources-${platform.wasmArch}"
        {
          passthru.ci.heavy = true;
          normal = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-${platform.wasmArch}";
            init = "${executables}/vfs.wasm";
          };
          signal = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-signal-${platform.wasmArch}";
            init = "${executables}/vfs-signal.wasm";
            cpus = 2;
          };
          exit = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-exit-${platform.wasmArch}";
            init = "${executables}/vfs-exit.wasm";
            cpus = 2;
          };
          lastFd = vm-test-copy.rawInitramfsTest {
            name = "mmap-vfs-last-fd-${platform.wasmArch}";
            init = "${executables}/vfs-last-fd.wasm";
            cpus = 2;
          };
          releaseConfig = vm-test.rawInitramfsTest {
            name = "mmap-copy-${platform.wasmArch}";
            init = "${executables}/copy.wasm";
          };
        }
        ''
          mkdir $out
          ln -s "$normal" $out/normal
          ln -s "$signal" $out/signal
          ln -s "$exit" $out/exit
          ln -s "$lastFd" $out/last-fd
          ln -s "$releaseConfig" $out/release-config
        '';
    passthru.checks.erofs = vm-test-copy.rawInitramfsTest {
      name = "mmap-erofs-${platform.wasmArch}";
      init = "${executables}/erofs.wasm";
      cpus = 4;
      disks = [
        provenanceImage
        provenanceImage
      ];
      snapshotFirstDisk = true;
      readOnlyDisks = true;
    };
    passthru.checks.erofs-errors = vm-test-copy.rawInitramfsTest {
      name = "mmap-erofs-errors-${platform.wasmArch}";
      init = "${executables}/erofs-errors.wasm";
      disks = [ readErrorImage ];
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
