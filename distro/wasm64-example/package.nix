# SPDX-License-Identifier: MIT
{
  pkgs,
  bytes,
  kernel-wasm64,
  guest-agent,
  python-wasm64,
  withPython ? false,
  withGit ? false,
}:
assert !withGit || withPython;
let
  source = ../../apps/wasm64-example;
  opfsWorker = import ../site/opfs-disk-worker.nix {
    inherit bytes pkgs;
    kernel = kernel-wasm64;
  };
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
      --alias:@lowland/guest=${../../packages/linux-guest/src}/index.ts \
      --alias:linux-wasm-opfs-device=${../../apps/site/opfs-device.js} \
      --external:@lowland/kernel --external:@lowland/kernel/plugin --external:@lowland/bytes \
      --outfile=$out/app.js
    cp ${source}/index.html $out/index.html
    cp ${opfsWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js
    ${pkgs.lib.optionalString withPython ''
      chmod u+w $out/index.html
      substituteInPlace $out/index.html \
        --replace-fail 'value="python" disabled' 'value="python"' \
        --replace-fail 'accept=".wasm,application/wasm"' 'accept=".wasm,.pyz,application/wasm,application/zip"' \
        --replace-fail 'Minimal BusyBox root (64 MiB); Python is not installed.' \
          ${pkgs.lib.escapeShellArg (
            if withGit then
              "Python + Git root (512 MiB), including standard library, ncurses, OpenSSL and CA certificates."
            else
              "Python root (256 MiB), including standard library, ncurses, OpenSSL and CA certificates."
          )}
    ''}
    cp ${source}/server.mjs $out/server.mjs
    cp ${source}/README.md ${source}/integrity.mjs $out/
    ${pkgs.lib.optionalString withGit ''
      cp ${python-wasm64.workspaceApplication}/git-workspace.pyz $out/git-workspace.pyz
      cp -r ${python-wasm64.workspaceApplication}/source $out/workspace-source
    ''}
    cp ${guest-agent.nativeWasm64.bootDisk} $out/agent-boot.img
    cp ${
      if withGit then
        guest-agent.nativeWasm64.rootfsPythonGitExt4
      else if withPython then
        guest-agent.nativeWasm64.rootfsPythonExt4
      else
        guest-agent.nativeWasm64.rootfsExt4
    } $out/root.ext4
    cp -r ${kernel-wasm64}/. $out/node_modules/@lowland/kernel/
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp ${../../license.md} $out/LICENSE-MIT.txt
    node $out/integrity.mjs --write
    node $out/integrity.mjs --check
  ''
