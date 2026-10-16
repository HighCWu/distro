# SPDX-License-Identifier: MIT
{
  pkgs,
  bytes,
  kernel-wasm64,
  guest-agent,
}:
let
  source = ../../apps/wasm64-example;
in
pkgs.runCommand "linux-wasm64-browser-example"
  {
    nativeBuildInputs = [
      pkgs.esbuild
      pkgs.nodejs
    ];
  }
  ''
    mkdir -p $out/node_modules/@lowland/{kernel,bytes}
    esbuild ${source}/app.js --bundle --platform=browser --format=esm --target=es2022 \
      --alias:@lowland/guest=${../../packages/linux-guest/src/index.ts} \
      --external:@lowland/kernel --external:@lowland/kernel/plugin --external:@lowland/bytes \
      --outfile=$out/app.js
    cp ${source}/index.html $out/index.html
    cp ${source}/server.mjs $out/server.mjs
    cp ${source}/README.md ${source}/integrity.mjs $out/
    cp ${guest-agent.nativeWasm64.bootDisk} $out/agent-boot.img
    cp ${guest-agent.nativeWasm64.rootfsExt4} $out/root.ext4
    cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp ${../../license.md} $out/LICENSE-MIT.txt
    node $out/integrity.mjs --write
    node $out/integrity.mjs --check
  ''
