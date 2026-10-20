# SPDX-License-Identifier: MIT
{
  pkgs,
  kernel,
  transformOnly ? false,
}:
# Private experiment, not an npm package or a replacement for the default kernel.
pkgs.runCommand "fork-worker-${if transformOnly then "transform" else "bundle"}-experiment"
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
    esbuild ${kernel}/dist/worker.js ${
      pkgs.lib.optionalString (!transformOnly) "--bundle"
    } --format=esm --platform=neutral \
      --target=es2024 --tree-shaking=false --ignore-annotations --keep-names \
      --legal-comments=inline --outfile=$out/dist/worker.js \
      --metafile=$out/worker-bundle-meta.json
    esbuild --version > $out/worker-bundle-version.txt
    node ${pkgs.lib.optionalString transformOnly "--experimental-vm-modules"} \
      ${./worker-bundle-check.mjs} ${kernel} $out ${if transformOnly then "transform" else "bundle"}
    node ${./worker-bundle-smoke.mjs} $out/dist/worker.js
  ''
