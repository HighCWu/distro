# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  musl,
  llvm-runtimes,
  platform,
  busybox,
  vm-test,
  extraChecks ? { },
}:
let
  ext4Disk =
    pkgs.runCommand "fiemap-sparse-runtime-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O extents,^has_journal -b 4096 -m 0 "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "fiemap-sparse-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm ext4 fallocate punch/zero, SEEK_DATA/SEEK_HOLE and FS_IOC_FIEMAP runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o fiemap-sparse-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      fiemap-sparse-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 fiemap-sparse-runtime $out/bin/fiemap-sparse-runtime
    notices=$out/share/licenses/fiemap-sparse-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fiemap-sparse-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ ext4Disk ];
    };
  }
  // extraChecks;
})
