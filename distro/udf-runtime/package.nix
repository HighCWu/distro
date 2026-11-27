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
  udfDisk =
    pkgs.runCommand "udf-runtime-disk-16m"
      {
        nativeBuildInputs = [ pkgs.udftools ];
      }
      ''
        truncate -s 16777216 "$out"
        mkudffs --utf8 --media-type=hd -b 4096 --lvid=WASMUDF --vid=WASMUDF "$out"
      '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "udf-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm UDF 2.01 mount, statfs, LFN, truncate, rename, symlink and hardlink runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o udf-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      udf-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 udf-runtime $out/bin/udf-runtime
    notices=$out/share/licenses/udf-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "udf-runtime-${platform.wasmArch}";
      init = ./runtime-test.sh;
      cpus = 1;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      disks = [ udfDisk ];
    };
  }
  // extraChecks;
})
