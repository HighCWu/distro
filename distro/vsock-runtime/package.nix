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
  pname = "vsock-runtime";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];

  buildPhase = ''
    runHook preBuild
    $CC -I${linux.headers}/include -O2 -Wall -Wextra -Werror ${./runtime.c} -o vsock-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      vsock-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 vsock-runtime "$out/bin/vsock-runtime"
    runHook postInstall
  '';

  passthru.checks.runtime = vm-test.rawInitramfsTest {
    name = "vsock-runtime-${platform.wasmArch}";
    init = "${finalAttrs.finalPackage}/bin/vsock-runtime";
    vsockRoundtrip = true;
    recordRuntimeLog = true;
  };
})
