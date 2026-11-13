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
  pname = "key-watch-runtime";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [ pkgs.nodejs ];
  buildPhase = ''
    runHook preBuild
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o key-watch-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      key-watch-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 key-watch-runtime $out/bin/key-watch-runtime
    notices=$out/share/licenses/key-watch-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  passthru.checks.runtime = vm-test.installedTest {
    name = "key-watch-runtime-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
  };
})
