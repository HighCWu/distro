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
  loopDisk =
    pkgs.runCommand "loop-device-runtime-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        mkdir -p root
        printf 'loop-seed-v1\n' >root/seed.txt
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O extents,^has_journal -b 4096 -m 0 -d root "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "loop-device-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm /dev/loop-control and ext4 loop device mount/rw/detach runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o loop-device-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      loop-device-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 loop-device-runtime $out/bin/loop-device-runtime
    install -Dm644 ${loopDisk} $out/share/loop-device-runtime/disk.img
    notices=$out/share/licenses/loop-device-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "loop-device-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
    };
  }
  // extraChecks;
})
