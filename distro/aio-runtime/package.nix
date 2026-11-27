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
stdenv.mkDerivation (finalAttrs: {
  pname = "aio-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux native AIO PREAD/PWRITE and eventfd runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o aio-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      aio-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 aio-runtime $out/bin/aio-runtime
    notices=$out/share/licenses/aio-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "aio-runtime-${platform.wasmArch}";
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
