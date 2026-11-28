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
  pname = "eventfd-signalfd-epoll-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm eventfd2, signalfd4, and epoll EPOLLET/ONESHOT/RDHUP check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -std=c11 -O2 -Wall -Wextra -Werror -Wsign-compare ${./runtime.c} \
      -o eventfd-signalfd-epoll-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      eventfd-signalfd-epoll-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 eventfd-signalfd-epoll-runtime \
      $out/bin/eventfd-signalfd-epoll-runtime
    notices=$out/share/licenses/eventfd-signalfd-epoll-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "eventfd-signalfd-epoll-runtime-${platform.wasmArch}";
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
