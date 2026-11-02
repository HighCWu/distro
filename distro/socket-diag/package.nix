# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  platform,
  musl,
  llvm-runtimes,
  busybox,
  iproute2-ss,
  vm-test,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "socket-diag";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o verify
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      verify ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 verify $out/libexec/socket-diag/verify
    notices=$out/share/licenses/socket-diag
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  passthru.checks.runtime = vm-test.installedTest {
    name = "socket-diag-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      iproute2-ss
      finalAttrs.finalPackage
    ];
    files."/ss.sha256" = {
      source = "${iproute2-ss.sourceBundle}/BINARY_SHA256SUMS";
      mode = "0444";
    };
    cpus = 2;
  };
})
