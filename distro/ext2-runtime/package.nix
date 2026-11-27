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
  ext2Disk =
    pkgs.runCommand "ext2-runtime-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        mkdir -p root
        printf 'ext2-seed-v1\n' >root/seed.txt
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext2 -b 4096 -m 0 -d root "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "ext2-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm ext2 mount, statfs magic, seed read, rw fsync, and unlink check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o ext2-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      ext2-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 ext2-runtime $out/bin/ext2-runtime
    notices=$out/share/licenses/ext2-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "ext2-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ ext2Disk ];
    };
  }
  // extraChecks;
})
