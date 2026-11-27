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
  vfatDisk =
    pkgs.runCommand "vfat-runtime-fat32-disk-8m"
      {
        nativeBuildInputs = [ pkgs.dosfstools ];
      }
      ''
        truncate -s 8388608 "$out"
        mkfs.vfat -F 32 -n WASMVFAT "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "vfat-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm VFAT FAT32 mount, statfs, LFN, truncate, rename and unsupported link runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o vfat-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      vfat-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 vfat-runtime $out/bin/vfat-runtime
    notices=$out/share/licenses/vfat-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "vfat-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ vfatDisk ];
    };
  }
  // extraChecks;
})
