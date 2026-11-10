# SPDX-License-Identifier: MIT
{
  pkgs,
  platform,
  kernel,
  vm-test,
}:

assert platform.addressBits == 64;
assert platform.wasmArch == "wasm64";
let
  manifest = pkgs.writeText "linux-wasm-runtime-assets-wasm64.json" (
    builtins.toJSON {
      schemaVersion = 1;
      inherit (platform) addressBits;
      maxMemoryBytes = platform.maximumMemoryBytes;
      kernel = toString kernel;
      runner = toString vm-test.runner;
    }
  );
in
pkgs.runCommand "linux-wasm-runtime-assets-wasm64"
  {
    nativeBuildInputs = [ pkgs.jq ];
  }
  ''
    test -s ${kernel}/dist/index.js
    test -s ${kernel}/node_modules/@lowland/bytes/dist/index.js
    test -s ${kernel}/vmlinux.wasm
    jq --exit-status '.schemaVersion == 1 and .wasmBits == 64' \
      ${kernel}/linux-build/build.json >/dev/null
    test -s ${kernel}/linux-build/COPYING
    test -s ${kernel}/linux-build/LICENSES/preferred/GPL-2.0
    test -s ${kernel}/linux-build/LICENSES/exceptions/Linux-syscall-note
    test -s ${kernel.sourceBundle}/linux-source.tar.gz
    test -s ${vm-test.runner}/run-test.js
    test -s ${vm-test.runner}/protocol.js
    test -x ${pkgs.nodejs}/bin/node
    test -x ${pkgs.cpio}/bin/cpio

    mkdir -p "$out/sources"
    ln -s ${kernel} "$out/kernel"
    ln -s ${vm-test.runner} "$out/runner"
    ln -s ${pkgs.nodejs}/bin/node "$out/node"
    ln -s ${pkgs.cpio}/bin/cpio "$out/cpio"
    ln -s ${kernel.sourceBundle} "$out/sources/kernel-source-bundle"
    ln -s ${kernel}/linux-build "$out/sources/linux-build-materials"
    install -Dm644 ${manifest} "$out/manifest.json"
  ''
