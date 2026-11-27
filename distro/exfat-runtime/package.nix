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
  exfatDisk =
    pkgs.runCommand "exfat-runtime-disk-16m"
      {
        nativeBuildInputs = [ pkgs.exfatprogs ];
      }
      ''
        truncate -s 16777216 "$out"
        mkfs.exfat -n WASMEXFAT "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "exfat-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm exFAT mount, statfs, UTF-8 LFN, truncate, rename and unsupported link runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o exfat-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      exfat-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 exfat-runtime $out/bin/exfat-runtime
    notices=$out/share/licenses/exfat-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "exfat-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ exfatDisk ];
    };
  }
  // extraChecks;
})
