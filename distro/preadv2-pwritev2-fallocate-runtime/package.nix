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
    pkgs.runCommand "preadv2-fallocate-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O extents,^has_journal -b 4096 -m 0 "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "preadv2-pwritev2-fallocate-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm preadv2/pwritev2, fallocate punch-hole, and sendfile check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror -Wsign-compare ${./runtime.c} \
      -o preadv2-pwritev2-fallocate-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      preadv2-pwritev2-fallocate-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 preadv2-pwritev2-fallocate-runtime \
      $out/bin/preadv2-pwritev2-fallocate-runtime
    notices=$out/share/licenses/preadv2-pwritev2-fallocate-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "preadv2-pwritev2-fallocate-runtime-${platform.wasmArch}";
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
