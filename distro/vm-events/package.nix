# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  musl,
  llvm-runtimes,
  busybox,
  platform,
  vm-test,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "vm-events";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o vm-events
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      vm-events ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 vm-events $out/bin/vm-events
    notices=$out/share/licenses/vm-events
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  passthru.checks.runtime = vm-test.installedTest {
    name = "vm-events-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
    cpus = 2;
  };
})
