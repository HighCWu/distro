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
  pname = "posix-spawn-cloexec-sigmask-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm posix_spawn SETSIGMASK, SETSIGDEF, dup2, and O_CLOEXEC check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -std=c11 -O2 -Wall -Wextra -Werror -Wsign-compare ${./runtime.c} \
      -o posix-spawn-cloexec-sigmask-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      posix-spawn-cloexec-sigmask-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 posix-spawn-cloexec-sigmask-runtime \
      $out/bin/posix-spawn-cloexec-sigmask-runtime
    notices=$out/share/licenses/posix-spawn-cloexec-sigmask-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "posix-spawn-cloexec-sigmask-runtime-${platform.wasmArch}";
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
