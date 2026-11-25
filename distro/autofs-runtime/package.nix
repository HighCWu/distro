# SPDX-License-Identifier: MIT
{
  pkgs,
  stdenv,
  lib,
  linux,
  platform,
  vm-test,
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "autofs-runtime";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -I${linux.headers}/include -O2 -Wall -Wextra -Werror ${./runtime.c} -o autofs-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      autofs-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 autofs-runtime "$out/bin/autofs-runtime"
    runHook postInstall
  '';

  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "autofs-runtime-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/bin/autofs-runtime";
  };
})
