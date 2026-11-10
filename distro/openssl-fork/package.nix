# SPDX-License-Identifier: MIT
{
  pkgs,
  lib,
  stdenv,
  platform,
  openssl,
  sdk,
  sdk-fork-automatic-poll-libc,
  llvm-toolchain,
  musl,
  llvm-runtimes,
  busybox,
  vm-test,
  extraChecks ? { },
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "openssl-fork";
  inherit (openssl) version src;
  outputs = [
    "out"
    "buildMaterials"
  ];

  # Keep the existing mlock compatibility change, without changing upstream
  # fork detection or adding any OpenSSL source patches for fork support.
  patches = [ ../openssl/speed-no-mlock-on-wasm.patch ];

  meta = {
    description = "OpenSSL CLI using the experimental automatic fork profile";
    license = [
      lib.licenses.asl20
      lib.licenses.mit
    ];
  };
  passthru.apk = {
    depends = [ "busybox" ];
    license = "Apache-2.0 AND MIT AND Apache-2.0 WITH LLVM-exception";
  };

  nativeBuildInputs = [
    sdk
    sdk-fork-automatic-poll-libc
    llvm-toolchain
    pkgs.gnumake
    pkgs.nodejs
    pkgs.perl
  ];

  configurePhase = ''
    runHook preConfigure
    perl ./Configure linux-generic${toString platform.addressBits} \
      "CC=${sdk-fork-automatic-poll-libc}/bin/wasm-linux-fork-cc" \
      "AR=${llvm-toolchain}/bin/llvm-ar" \
      "RANLIB=${llvm-toolchain}/bin/llvm-ranlib" \
      --prefix=/opt/openssl-fork \
      --libdir=lib \
      --openssldir=/opt/openssl-fork/ssl \
      no-shared \
      no-dso \
      no-dynamic-engine \
      no-async \
      no-afalgeng \
      no-secure-memory \
      no-tests
    runHook postConfigure
  '';

  enableParallelBuilding = true;

  postBuild = ''
    test -x apps/openssl
    node ${../busybox/check-binary.mjs} ${../../packages/kernel/src/wasm_binary.ts} \
      apps/openssl ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}
    node --input-type=module <<'NODE'
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";

    const module = new WebAssembly.Module(readFileSync("apps/openssl"));
    const exports = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    const imports = WebAssembly.Module.imports(module);
    for (const name of [
      "asyncify_get_state",
      "asyncify_start_unwind",
      "asyncify_stop_unwind",
      "asyncify_start_rewind",
      "asyncify_stop_rewind",
    ])
      assert.ok(exports.has(name), "automatic fork link omitted " + name);
    assert.ok(
      imports.some(
        ({ module, name, kind }) =>
          module === "linux_user_poll_v2" && name === "checkpoint" && kind === "function",
      ),
      "automatic fork link omitted the libc polling checkpoint",
    );
    NODE
  '';

  installTargets = [
    "install_sw"
    "install_ssldirs"
  ];
  installFlags = [ "DESTDIR=$(out)" ];

  postInstall = ''
    test -x "$out/opt/openssl-fork/bin/openssl"
    test -s "$out/opt/openssl-fork/ssl/openssl.cnf"

    notices="$out/share/licenses/openssl-fork"
    materials="$buildMaterials/share/openssl-fork-materials"
    mkdir -p "$notices" "$materials"
    install -Dm644 LICENSE.txt "$notices/OPENSSL-LICENSE.txt"
    install -Dm644 ${../sdk/LICENSE.MIT} "$notices/LOCAL-ADDITIONS.MIT"
    install -Dm644 ${sdk}/share/linux-wasm-sdk/licenses/SDK-MIT.txt \
      "$notices/SDK-MIT.txt"
    install -Dm644 \
      ${sdk-fork-automatic-poll-libc}/share/linux-wasm-fork-sdk/build-materials/licenses/Binaryen-LICENSE \
      "$notices/Binaryen-LICENSE"
    install -Dm644 ${musl.src}/COPYRIGHT "$notices/musl-COPYRIGHT"
    install -Dm644 ${llvm-runtimes.src}/compiler-rt/LICENSE.TXT \
      "$notices/compiler-rt-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/llvm/LICENSE.TXT \
      "$notices/LLVM-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/clang/LICENSE.TXT \
      "$notices/Clang-LICENSE.TXT"
    install -Dm644 ${llvm-toolchain.licenseSource}/lld/LICENSE.TXT \
      "$notices/LLD-LICENSE.TXT"

    cp ${./package.nix} ${./runtime-test.sh} \
      ${../openssl/speed-no-mlock-on-wasm.patch} configdata.pm Makefile \
      "$materials/"
    ln -s ${openssl.src} "$materials/source"
    ln -s ${sdk.buildMaterials} "$materials/standard-sdk"
    ln -s ${sdk-fork-automatic-poll-libc.buildMaterials} "$materials/fork-sdk"
    ln -s ${llvm-toolchain.licenseSource} "$materials/llvm-toolchain-source"
    ln -s ${llvm-runtimes.src} "$materials/llvm-runtimes-source"
    ln -s ${musl.src} "$materials/musl-source"
  '';

  passthru.checks = {
    runtime = vm-test.installedTest {
      name = "openssl-fork-${platform.wasmArch}";
      init = ./runtime-test.sh;
      contents = [
        busybox
        finalAttrs.finalPackage
      ];
      cpus = 2;
    };
  }
  // extraChecks;
})
