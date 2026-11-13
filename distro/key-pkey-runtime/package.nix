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
  pname = "key-pkey-runtime";
  version = "1";
  dontUnpack = true;
  meta.license = lib.licenses.mit;
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.openssl
  ];
  buildPhase = ''
    runHook preBuild
    # Generate an ephemeral key solely for this runtime test.
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out test-private.pem 2>/dev/null
    openssl pkcs8 -topk8 -nocrypt -in test-private.pem -outform DER -out test-private.der
    rm test-private.pem
    $CC -O2 -Wall -Wextra -Werror ${./runtime.c} -o key-pkey-runtime
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      key-pkey-runtime ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 key-pkey-runtime $out/bin/key-pkey-runtime
    install -Dm644 ${./test-certificate.der} $out/share/key-pkey-runtime/test-certificate.der
    install -Dm644 test-private.der $out/share/key-pkey-runtime/test-private.der
    notices=$out/share/licenses/key-pkey-runtime
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LICENSE.MIT"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT "$notices/compiler-rt-LICENSE.TXT"
    runHook postInstall
  '';
  passthru.checks.runtime = vm-test.installedTest {
    name = "key-pkey-runtime-${platform.wasmArch}";
    init = ./runtime-test.sh;
    contents = [
      busybox
      finalAttrs.finalPackage
    ];
    files."/test-certificate.der" =
      "${finalAttrs.finalPackage}/share/key-pkey-runtime/test-certificate.der";
    files."/test-private.der" = "${finalAttrs.finalPackage}/share/key-pkey-runtime/test-private.der";
  };
})
