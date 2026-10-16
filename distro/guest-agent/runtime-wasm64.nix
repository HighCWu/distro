# SPDX-License-Identifier: MIT
{
  bytes,
  image,
  kernel,
  node-workspace,
  pkgs,
  sdk-wasm64,
}:
let
  program = pkgs.runCommand "agent-runtime-init-wasm64" { } ''
    mkdir $out
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror -pthread \
      -I${./.} ${./runtime-init.c} -o $out/init.wasm
    ${sdk-wasm64}/bin/wasm-linux-cc -Wall -Wextra -Werror \
      ${./runtime-child.c} -o $out/child.wasm
  '';
  initramfs = image.mkInitramfs {
    name = "agent-runtime-wasm64";
    init = "${program}/init.wasm";
    files."/bin/agent-runtime-child" = "${program}/child.wasm";
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "linux-agent-runtime-wasm64";
  version = "0.0.0";
  src = ../..;
  passthru.ci.heavy = true;
  env.CI = "true";
  pnpmDeps = node-workspace.deps;
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.pnpmConfigHook
    node-workspace.pnpm
  ];
  buildPhase = ''
    runHook preBuild
    cp ${kernel}/vmlinux.wasm packages/kernel/vmlinux.wasm
    cp -rT ${kernel}/dist packages/kernel/dist
    cp -rT ${bytes}/dist packages/bytes/dist
    pnpm --filter=@lowland/guest-tests check
    AGENT_WASM64_INITRAMFS=${initramfs} \
      timeout --kill-after=5 180 pnpm --filter=@lowland/guest-tests exec \
      node --test agent-wasm64-runtime.ts
    runHook postBuild
  '';
  installPhase = ''
    mkdir $out
  '';
}
