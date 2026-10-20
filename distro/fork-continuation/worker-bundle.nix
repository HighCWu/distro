# SPDX-License-Identifier: MIT
{ pkgs, kernel }:
# Private experiment, not an npm package or a replacement for the default kernel.
pkgs.runCommand "fork-worker-bundle-experiment"
  {
    nativeBuildInputs = [
      pkgs.esbuild
      pkgs.nodejs
    ];
  }
  ''
    mkdir $out
    cp -r ${kernel}/. $out/
    chmod -R u+w $out
    esbuild ${kernel}/dist/worker.js --bundle --format=esm --platform=neutral \
      --target=es2024 --tree-shaking=false --ignore-annotations --keep-names \
      --legal-comments=inline --outfile=$out/dist/worker.js \
      --metafile=$out/worker-bundle-meta.json
    esbuild --version > $out/worker-bundle-version.txt
    node ${./worker-bundle-check.mjs} ${kernel} $out
    node ${./worker-bundle-smoke.mjs} $out/dist/worker.js
  ''
