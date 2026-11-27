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
    pkgs.runCommand "overlay-runtime-ext4-disk-8m"
      {
        nativeBuildInputs = [ pkgs.e2fsprogs ];
      }
      ''
        truncate -s 8388608 "$out"
        mke2fs -q -F -t ext4 -O ext_attr,^has_journal -m 0 "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "overlay-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm overlayfs copy-up, xattr, whiteout, opaque directory and rename runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o overlay-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      overlay-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 overlay-runtime $out/bin/overlay-runtime
    notices=$out/share/licenses/overlay-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "overlay-runtime-${platform.wasmArch}";
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
