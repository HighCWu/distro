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
  pname = "fcntl-dupfd-cloexec-flags-runtime";
  version = "1";
  dontUnpack = true;
  meta = {
    description = "Linux/Wasm dup/dup2/dup3, F_DUPFD/F_DUPFD_CLOEXEC, and FD_CLOEXEC check";
    license = lib.licenses.mit;
  };

  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -std=c11 -O2 -Wall -Wextra -Werror -Wsign-compare ${./runtime.c} \
      -o fcntl-dupfd-cloexec-flags-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      fcntl-dupfd-cloexec-flags-runtime ${toString platform.addressBits} \
      ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 fcntl-dupfd-cloexec-flags-runtime \
      $out/bin/fcntl-dupfd-cloexec-flags-runtime
    notices=$out/share/licenses/fcntl-dupfd-cloexec-flags-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';

  passthru.checks = {
    runtime = vm-test.rawInitramfsTest {
      name = "fcntl-dupfd-cloexec-flags-runtime-${platform.wasmArch}";
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
