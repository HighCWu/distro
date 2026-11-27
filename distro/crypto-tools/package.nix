# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  musl,
  llvm-runtimes,
  busybox,
  libkcapi,
  platform,
  vm-test,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "crypto-tools";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./unpriv-exec.c} -o unpriv-exec
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      unpriv-exec ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 unpriv-exec $out/libexec/crypto-tools/unpriv-exec
    notices=$out/share/licenses/crypto-tools
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  passthru.checks.runtime = vm-test.installedTest {
    name = "crypto-tools-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      libkcapi
      finalAttrs.finalPackage
    ];
    files."/crypto-tools.sha256" = {
      source = "${libkcapi.sourceBundle}/BINARY_SHA256SUMS";
      mode = "0444";
    };
    cpus = 2;
  };
})
