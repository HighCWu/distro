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
  pname = "dup-pipe-nonblock-fionread-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm pipe2, dup/dup2/dup3, FIONREAD, poll, and pipe size runtime check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror -Wsign-compare ${./runtime.c} \
      -o dup-pipe-nonblock-fionread-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      dup-pipe-nonblock-fionread-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dup-pipe-nonblock-fionread-runtime \
      $out/bin/dup-pipe-nonblock-fionread-runtime
    notices=$out/share/licenses/dup-pipe-nonblock-fionread-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "dup-pipe-nonblock-fionread-runtime-${platform.wasmArch}";
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
