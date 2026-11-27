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
    pkgs.runCommand "statx-copy-file-range-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O extents,^has_journal -b 4096 -m 0 "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "statx-copy-file-range-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm ext4 statx, copy_file_range, preadv2/pwritev2, and punch check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o statx-copy-file-range-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      statx-copy-file-range-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 statx-copy-file-range-runtime $out/bin/statx-copy-file-range-runtime
    notices=$out/share/licenses/statx-copy-file-range-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "statx-copy-file-range-runtime-${platform.wasmArch}";
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
